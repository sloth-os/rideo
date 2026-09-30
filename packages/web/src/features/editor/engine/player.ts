import { type Timeline, timelineDuration } from '@rideo/shared';
import { scheduleAudio } from './audio';
import { Compositor } from './compositor';
import type { MediaPool } from './media-pool';

/** Preview playback clocked by the AudioContext; frames come from sequential WebCodecs iterators. */
export class Player {
  private readonly compositor: Compositor;
  private readonly ctx: CanvasRenderingContext2D;
  private audio: AudioContext | null = null;
  private nodes: AudioScheduledSourceNode[] = [];
  private raf = 0;
  private epoch = 0;
  private startedAt = 0;
  private from = 0;
  private drawing = false;
  private pending = false;
  playing = false;
  time = 0;
  onTime?: (t: number) => void;
  onPlaying?: (playing: boolean) => void;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly pool: MediaPool,
    private timeline: Timeline,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.compositor = new Compositor(pool, timeline);
  }

  get duration(): number {
    return timelineDuration(this.timeline);
  }

  setTimeline(t: Timeline): void {
    this.timeline = t;
    this.compositor.setTimeline(t);
    if (this.playing) this.start(this.time);
    else void this.draw();
  }

  /**
   * Draws the frame at `time`. A request that arrives while a draw is in flight (a seek while the first frame is
   * still loading, e.g. a local proxy being built) is not dropped: the latest time is drawn once the current
   * draw finishes.
   */
  async draw(): Promise<void> {
    if (this.drawing) {
      this.pending = true;
      return;
    }
    this.drawing = true;
    try {
      do {
        this.pending = false;
        await this.compositor.render(
          this.ctx,
          Math.min(this.time, Math.max(0, this.duration - 1e-3)),
          this.canvas.width,
          this.canvas.height,
          false,
        );
      } while (this.pending && !this.playing);
    } finally {
      this.drawing = false;
    }
  }

  async seek(t: number): Promise<void> {
    this.time = Math.max(0, Math.min(t, this.duration));
    this.onTime?.(this.time);
    if (this.playing) this.start(this.time);
    else {
      this.compositor.resetCursors();
      await this.draw();
    }
  }

  async play(): Promise<void> {
    if (this.playing || this.duration <= 0) return;
    if (this.time >= this.duration - 0.05) this.time = 0;
    this.audio ??= new AudioContext();
    await this.audio.resume();
    this.playing = true;
    this.onPlaying?.(true);
    this.start(this.time);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.epoch++;
    cancelAnimationFrame(this.raf);
    this.stopAudio();
    this.onPlaying?.(false);
  }

  private stopAudio(): void {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        // already stopped
      }
    }
    this.nodes = [];
  }

  private start(from: number): void {
    const audio = this.audio!;
    const epoch = ++this.epoch;
    this.stopAudio();
    cancelAnimationFrame(this.raf);
    this.compositor.resetCursors();
    this.from = from;
    this.startedAt = audio.currentTime + 0.12;
    void scheduleAudio(audio, this.timeline, this.pool, from, this.startedAt, () => epoch !== this.epoch)
      .then((nodes) => {
        if (epoch === this.epoch) this.nodes.push(...nodes);
        else for (const n of nodes) n.stop();
      })
      .catch(() => undefined);
    const loop = () => {
      if (!this.playing || epoch !== this.epoch) return;
      const t = this.from + Math.max(0, audio.currentTime - this.startedAt);
      if (t >= this.duration) {
        this.time = this.duration;
        this.onTime?.(this.time);
        this.pause();
        return;
      }
      if (!this.drawing) {
        this.drawing = true;
        this.compositor
          .render(this.ctx, t, this.canvas.width, this.canvas.height, true)
          .catch(() => undefined)
          .finally(() => {
            this.drawing = false;
          });
        this.time = t;
        this.onTime?.(t);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    this.pause();
    this.compositor.dispose();
    void this.audio?.close();
  }
}
