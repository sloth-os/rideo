import type { PdfLine } from '@rideo/shared';

/**
 * A small PDF 1.4 writer for printable documents (the shot list, docs/design/storyboard.md#shot-list): pages of
 * Helvetica text, rules and JPEG images. The standard fonts need no font files on the server.
 */

const WIN_ANSI: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '™': 0x99,
};

/** A PDF string literal in WinAnsi (characters outside it become '?'). */
function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    let code = WIN_ANSI[ch] ?? ch.codePointAt(0)!;
    if (code > 0xff || (code >= 0x80 && code < 0xa0 && !Object.values(WIN_ANSI).includes(code))) code = 0x3f;
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${String.fromCharCode(code)}`;
    else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

/** Approximate Helvetica advance widths (per 1000 em) for wrapping. */
function charWidth(ch: string, bold: boolean): number {
  if (/[ il.,:;'|!]/.test(ch)) return 278;
  if (/[fjrt()[\]-]/.test(ch)) return 333;
  if (/[mw]/.test(ch)) return 833;
  if (/[MW]/.test(ch)) return 889;
  if (/[A-Z]/.test(ch)) return bold ? 722 : 667;
  return bold ? 611 : 556;
}

export function textWidth(text: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, bold);
  return (w * size) / 1000;
}

/** Greedy word wrap to `width` points; at most `maxLines` lines (the last ends with … when cut). */
export function wrapText(text: string, size: number, width: number, maxLines = 99, bold = false): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/\s*\S*$/, '')}…`;
    return kept;
  }
  return lines;
}

interface Image {
  data: Buffer;
  width: number;
  height: number;
}

export class PdfDocument {
  private readonly pages: { width: number; height: number; ops: string[]; images: Set<number> }[] = [];
  private readonly images: Image[] = [];

  addPage(width = 842, height = 595): this {
    this.pages.push({ width, height, ops: [], images: new Set() });
    return this;
  }

  private get page() {
    const p = this.pages[this.pages.length - 1];
    if (!p) throw new Error('addPage first');
    return p;
  }

  /** Text with its baseline `y` points from the top of the page. */
  text(
    x: number,
    y: number,
    text: string,
    opts: { size?: number; bold?: boolean; gray?: number } = {},
  ): this {
    const p = this.page;
    const size = opts.size ?? 10;
    p.ops.push(
      `BT ${opts.gray !== undefined ? `${opts.gray} g ` : '0 g '}/${opts.bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${(p.height - y).toFixed(2)} Td ${pdfString(text)} Tj ET`,
    );
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, gray = 0.8): this {
    const p = this.page;
    p.ops.push(
      `${gray} G 0.5 w ${x1.toFixed(2)} ${(p.height - y1).toFixed(2)} m ${x2.toFixed(2)} ${(p.height - y2).toFixed(2)} l S`,
    );
    return this;
  }

  /** A JPEG drawn into the box (top-left `x`, `y`; `w` × `h` points). */
  jpeg(image: Image, x: number, y: number, w: number, h: number): this {
    const p = this.page;
    let index = this.images.indexOf(image);
    if (index < 0) index = this.images.push(image) - 1;
    p.images.add(index);
    p.ops.push(
      `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(p.height - y - h).toFixed(2)} cm /Im${index} Do Q`,
    );
    return this;
  }

  toBuffer(): Buffer {
    const chunks: Buffer[] = [];
    const offsets: number[] = [];
    let length = 0;
    const write = (b: Buffer | string) => {
      const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
      chunks.push(buf);
      length += buf.length;
    };
    const object = (id: number, body: (Buffer | string)[]) => {
      offsets[id] = length;
      write(`${id} 0 obj\n`);
      for (const b of body) write(b);
      write('\nendobj\n');
    };
    // 1 catalog, 2 pages, 3–4 fonts, then images, then page + content pairs.
    const imageBase = 5;
    const pageBase = imageBase + this.images.length;
    write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    const kids = this.pages.map((_, i) => `${pageBase + i * 2} 0 R`).join(' ');
    object(2, [`<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`]);
    object(3, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
    object(4, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
    this.images.forEach((img, i) => {
      object(imageBase + i, [
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.data.length} >>\nstream\n`,
        img.data,
        '\nendstream',
      ]);
    });
    this.pages.forEach((p, i) => {
      const id = pageBase + i * 2;
      const xobjects = [...p.images].map((k) => `/Im${k} ${imageBase + k} 0 R`).join(' ');
      object(id, [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width} ${p.height}] /Contents ${id + 1} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> >>`,
      ]);
      const content = Buffer.from(p.ops.join('\n'), 'latin1');
      object(id + 1, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    });
    const xref = length;
    const count = pageBase + this.pages.length * 2;
    write(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let id = 1; id < count; id++) write(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }
}

/** The text lines of a PDF (screenplay import): items grouped by baseline, left to right, top to bottom. */
export async function pdfTextLines(data: Uint8Array): Promise<PdfLine[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data, disableFontFace: true, verbosity: 0 }).promise;
  const lines: PdfLine[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const height = page.getViewport({ scale: 1 }).height;
      const content = await page.getTextContent();
      const rows = new Map<number, { x: number; text: string; end: number }[]>();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [, , , , x, y] = item.transform as number[];
        const top = Math.round((height - y!) * 2) / 2;
        const key = [...rows.keys()].find((k) => Math.abs(k - top) < 2) ?? top;
        const row = rows.get(key) ?? [];
        row.push({ x: x!, text: item.str, end: x! + item.width });
        rows.set(key, row);
      }
      for (const [y, row] of rows) {
        row.sort((a, b) => a.x - b.x);
        let text = '';
        let end = row[0]!.x;
        for (const part of row) {
          text += part.x - end > 1 && text ? ` ${part.text}` : part.text;
          end = part.end;
        }
        lines.push({ page: n, x: row[0]!.x, y, text });
      }
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return lines;
}
