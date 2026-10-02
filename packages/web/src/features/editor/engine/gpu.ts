import type { CubeLut } from '@rideo/shared';
import { type GpuDraw, LAYER_FLOATS, layerUniforms, lutTexels, wipeScissor } from './gpu-plan';

/**
 * WebGPU compositing (docs/design/engine-performance.md#webgpu-compositing): each draw is a textured quad placed by an
 * affine map, graded in the shader (effects, LUT), with its matte as alpha, blended with premultiplied alpha over
 * black; titles arrive as one transparent layer. The result is an ImageBitmap the caller draws where it needs it.
 */

const SHADER = /* wgsl */ `
struct Layer {
  pos: vec4f,
  pos2: vec4f,
  uv: vec4f,
  muv: vec4f,
  fx: vec4f,
  lut: vec4f,
  lutMin: vec4f,
  lutMax: vec4f,
};
@group(0) @binding(0) var<uniform> L: Layer;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var matte: texture_2d<f32>;
@group(0) @binding(4) var lut3: texture_3d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) muv: vec2f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let c = corners[i];
  var o: VOut;
  o.pos = vec4f(L.pos.x * c.x + L.pos.y * c.y + L.pos.z, L.pos2.x * c.x + L.pos2.y * c.y + L.pos2.z, 0.0, 1.0);
  o.uv = L.uv.xy + c * L.uv.zw;
  o.muv = L.muv.xy + c * L.muv.zw;
  return o;
}

// The canvas's saturate() (Filter Effects): the luminance-preserving matrix.
fn saturate3(c: vec3f, s: f32) -> vec3f {
  let m = mat3x3f(
    vec3f(0.213 + 0.787 * s, 0.213 - 0.213 * s, 0.213 - 0.213 * s),
    vec3f(0.715 - 0.715 * s, 0.715 + 0.285 * s, 0.715 - 0.715 * s),
    vec3f(0.072 - 0.072 * s, 0.072 - 0.072 * s, 0.072 + 0.928 * s));
  return m * c;
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let s = textureSample(tex, samp, v.uv);
  let mt = textureSample(matte, samp, v.muv);
  if (L.lut.w > 0.5) {
    return vec4f(0.0, 0.0, 0.0, L.fx.w);
  }
  // brightness, contrast, saturation: the order of the canvas filters
  var rgb = s.rgb * L.fx.x;
  rgb = (rgb - vec3f(0.5)) * L.fx.y + vec3f(0.5);
  rgb = clamp(saturate3(clamp(rgb, vec3f(0.0), vec3f(1.0)), L.fx.z), vec3f(0.0), vec3f(1.0));
  if (L.lut.x > 0.0) {
    // the cube's index space, sampled at texel centres: trilinear like the CPU lookup
    let n = L.lut.y;
    let t = clamp((rgb - L.lutMin.rgb) / (L.lutMax.rgb - L.lutMin.rgb), vec3f(0.0), vec3f(1.0));
    let graded = textureSampleLevel(lut3, samp, (t * (n - 1.0) + vec3f(0.5)) / n, 0.0).rgb;
    rgb = mix(rgb, graded, L.lut.x);
  }
  var a = s.a * L.fx.w;
  if (L.lut.z > 0.5) {
    var luma = dot(mt.rgb, vec3f(0.299, 0.587, 0.114));
    if (L.lut.z > 1.5) {
      luma = 1.0 - luma;
    }
    a = a * luma;
  }
  return vec4f(rgb * a, a);
}
`;

type Source = CanvasImageSource & { width: number; height: number };

/** WebGPU usage flags (the spec's values; TypeScript's DOM library declares the types, not these constants). */
const TEXTURE = { COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 } as const;
const BUFFER = { COPY_DST: 0x08, UNIFORM: 0x40 } as const;

export class GpuRenderer {
  private readonly canvas: OffscreenCanvas;
  private readonly context: GPUCanvasContext;
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly white: GPUTexture;
  private readonly noLut: GPUTexture;
  private readonly frames: GPUTexture[] = [];
  private readonly mattes: GPUTexture[] = [];
  private readonly uniforms: GPUBuffer[] = [];
  private readonly luts = new WeakMap<CubeLut, GPUTexture>();
  lost = false;

  private constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
  ) {
    this.canvas = new OffscreenCanvas(2, 2);
    this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
    this.context.configure({ device, format, alphaMode: 'opaque' });
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    this.white = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);
    this.noLut = device.createTexture({
      size: [2, 2, 2],
      dimension: '3d',
      format: 'rgba16float',
      usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST,
    });
    device.lost.then(() => {
      this.lost = true;
    });
  }

  /** A renderer on this browser's GPU, or null when it has no WebGPU adapter. */
  static async create(): Promise<GpuRenderer | null> {
    const gpu = (globalThis.navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) return null;
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      return new GpuRenderer(device, gpu.getPreferredCanvasFormat());
    } catch {
      return null;
    }
  }

  private texture(list: GPUTexture[], i: number, w: number, h: number): GPUTexture {
    let t = list[i];
    if (!t || t.width !== w || t.height !== h) {
      t?.destroy();
      t = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST | TEXTURE.RENDER_ATTACHMENT,
      });
      list[i] = t;
    }
    return t;
  }

  private upload(list: GPUTexture[], i: number, source: Source): GPUTexture {
    const w = Math.max(1, Math.round(source.width));
    const h = Math.max(1, Math.round(source.height));
    const t = this.texture(list, i, w, h);
    this.device.queue.copyExternalImageToTexture(
      { source: source as GPUCopyExternalImageSource },
      { texture: t },
      [w, h],
    );
    return t;
  }

  private lutTexture(cube: CubeLut): GPUTexture {
    let t = this.luts.get(cube);
    if (!t) {
      const n = cube.size;
      t = this.device.createTexture({
        size: [n, n, n],
        dimension: '3d',
        format: 'rgba16float',
        usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST,
      });
      this.device.queue.writeTexture(
        { texture: t },
        lutTexels(cube),
        { bytesPerRow: n * 8, rowsPerImage: n },
        [n, n, n],
      );
      this.luts.set(cube, t);
    }
    return t;
  }

  private uniform(i: number): GPUBuffer {
    let b = this.uniforms[i];
    if (!b) {
      b = this.device.createBuffer({
        size: LAYER_FLOATS * 4,
        usage: BUFFER.UNIFORM | BUFFER.COPY_DST,
      });
      this.uniforms[i] = b;
    }
    return b;
  }

  /** Composites the draws (and the titles layer) over black at w × h; the caller closes the bitmap. */
  render(draws: GpuDraw[], titles: Source | null, w: number, h: number): ImageBitmap {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const all: GpuDraw[] = titles
      ? [
          ...draws,
          {
            kind: 'picture',
            source: titles,
            uv: [0, 0, 1, 1],
            placement: { cx: w / 2, cy: h / 2, w, h, rotation: 0 },
            opacity: 1,
          },
        ]
      : draws;
    const groups: { group: GPUBindGroup; scissor: [number, number, number, number] }[] = [];
    for (const [i, d] of all.entries()) {
      this.device.queue.writeBuffer(this.uniform(i), 0, layerUniforms(d, { width: w, height: h }));
      const frame = d.kind === 'picture' ? this.upload(this.frames, i, d.source) : this.white;
      const matte =
        d.kind === 'picture' && d.matte ? this.upload(this.mattes, i, d.matte.source) : this.white;
      const lut = d.kind === 'picture' && d.lut ? this.lutTexture(d.lut.cube) : this.noLut;
      groups.push({
        group: this.device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniform(i) } },
            { binding: 1, resource: this.sampler },
            { binding: 2, resource: frame.createView() },
            { binding: 3, resource: matte.createView() },
            { binding: 4, resource: lut.createView({ dimension: '3d' }) },
          ],
        }),
        scissor: wipeScissor(d.wipe, w, h),
      });
    }
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    for (const { group, scissor } of groups) {
      if (scissor[2] <= 0) continue;
      pass.setScissorRect(...scissor);
      pass.setBindGroup(0, group);
      pass.draw(6);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    // The frame leaves the canvas as a bitmap (drawing the WebGPU canvas itself reads nothing until it is presented)
    return this.canvas.transferToImageBitmap();
  }

  dispose(): void {
    for (const t of [...this.frames, ...this.mattes]) t.destroy();
    for (const b of this.uniforms) b.destroy();
    this.white.destroy();
    this.noLut.destroy();
    this.device.destroy();
  }
}
