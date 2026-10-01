import { type ScreenplayGenerateOutput, ScreenplayGenerateOutputSchema } from '../schemas/llm';

/**
 * Screenplay import (docs/design/storyboard.md#screenplay-import): Fountain, Final Draft (.fdx) and the text of PDF
 * screenplays become scenes with headings, action and dialogue, then the same normalization as a generated
 * screenplay.
 */

export type ScriptFormat = 'fountain' | 'fdx' | 'pdf';

export interface ParsedLine {
  character: string;
  line: string;
  parenthetical?: string;
}

export interface ParsedScene {
  heading: string;
  location: string;
  timeOfDay: string;
  summary: string;
  action: string;
  dialogue: ParsedLine[];
  /** Speaking characters in order of their first line. */
  characters: string[];
  /** Page lines the scene takes (one page ≈ 55 lines ≈ one minute). */
  lines: number;
}

export interface ParsedScript {
  title: string;
  scenes: ParsedScene[];
}

type Element = {
  type: 'heading' | 'action' | 'character' | 'parenthetical' | 'dialogue' | 'synopsis';
  text: string;
};

const HEADING = /^(?:INT\.?\/EXT|INT\/EXT|I\/E|INT|EXT|EST)[.\s]/i;
const EXTENSION = /\s*\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT['’]?D|CONTINUED|PRE-LAP|FILTERED|ON PHONE)\)\s*/gi;

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s/-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}

const TIME_OF_DAY =
  /^(?:DAY|NIGHT|MORNING|AFTERNOON|EVENING|DAWN|DUSK|SUNRISE|SUNSET|NOON|MIDNIGHT|LATER|MOMENTS LATER|CONTINUOUS|SAME|SAME TIME|MAGIC HOUR|(?:EARLY|LATE) (?:MORNING|AFTERNOON|EVENING|NIGHT))(?:\s*\(.*\))?$/i;

/** `INT. LIGHTHOUSE LAMP ROOM - NIGHT` → location "Lighthouse Lamp Room", time "night". */
export function parseHeading(heading: string): { location: string; timeOfDay: string } {
  const rest = heading
    .replace(/^\./, '')
    .replace(/#[^#]*#\s*$/, '')
    .replace(/^(?:INT\.?\/EXT|INT\/EXT|I\/E|INT|EXT|EST)\.?\s*/i, '')
    .trim();
  const parts = rest.split(/\s+[-–—]\s+/);
  const last = parts.length > 1 ? parts[parts.length - 1]!.trim() : '';
  const timeOfDay = TIME_OF_DAY.test(last) ? parts.pop()!.trim().toLowerCase() : '';
  return { location: titleCase(parts.join(' - ').trim()), timeOfDay };
}

function cueName(line: string): string {
  return line
    .replace(/^@/, '')
    .replace(EXTENSION, ' ')
    .replace(/\^\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const wrapped = (text: string, width: number) => Math.max(1, Math.ceil(text.length / width));

function buildScenes(elements: Element[]): ParsedScene[] {
  const scenes: ParsedScene[] = [];
  let scene: ParsedScene | null = null;
  let cue: string | null = null;
  let paren: string | undefined;
  // Consecutive dialogue lines of one speech are one line; a cue or parenthetical starts a new one.
  let newSpeech = true;
  const open = (heading: string) => {
    const { location, timeOfDay } = parseHeading(heading);
    scene = { heading, location, timeOfDay, summary: '', action: '', dialogue: [], characters: [], lines: 2 };
    scenes.push(scene);
  };
  for (const el of elements) {
    if (el.type === 'heading') {
      open(
        el.text
          .replace(/^\./, '')
          .replace(/\s*#[^#]*#\s*$/, '')
          .trim(),
      );
      cue = null;
      continue;
    }
    // Before the first scene heading: title page leftovers and notes, not a scene.
    if (!scene) continue;
    const s: ParsedScene = scene;
    switch (el.type) {
      case 'synopsis':
        s.summary = s.summary ? `${s.summary} ${el.text}` : el.text;
        break;
      case 'action':
        s.action = s.action ? `${s.action}\n${el.text}` : el.text;
        s.lines += wrapped(el.text, 60) + 1;
        cue = null;
        break;
      case 'character':
        cue = cueName(el.text);
        paren = undefined;
        newSpeech = true;
        s.lines += 2;
        break;
      case 'parenthetical':
        paren = el.text.replace(/^\(|\)$/g, '').trim();
        newSpeech = true;
        s.lines += 1;
        break;
      case 'dialogue': {
        if (!cue) {
          s.action = s.action ? `${s.action}\n${el.text}` : el.text;
          break;
        }
        const last = s.dialogue[s.dialogue.length - 1];
        if (!newSpeech && last?.character === cue) last.line = `${last.line} ${el.text}`;
        else s.dialogue.push({ character: cue, line: el.text, ...(paren ? { parenthetical: paren } : {}) });
        if (!s.characters.includes(cue)) s.characters.push(cue);
        paren = undefined;
        newSpeech = false;
        s.lines += wrapped(el.text, 35);
        break;
      }
    }
  }
  return scenes;
}

/** Fountain (https://fountain.io): headings, action, cues, parentheticals, dialogue, synopses, title page. */
export function parseFountain(source: string): ParsedScript {
  let text = source.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[\[[\s\S]*?\]\]/g, '');
  const lines = text.split('\n');
  let title = '';
  let i = 0;
  // Title page: `Key: value` lines up to the first blank line.
  if (/^[A-Za-z][A-Za-z ]*:/.test(lines[0] ?? '')) {
    for (; i < lines.length && lines[i]!.trim() !== ''; i++) {
      const m = /^Title:\s*(.*)$/i.exec(lines[i]!);
      if (m) {
        title = m[1]!.trim();
        // A multi-line title continues on indented lines.
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!)) title += ` ${lines[++i]!.trim()}`;
      }
    }
  }
  const elements: Element[] = [];
  let action: string[] = [];
  const flush = () => {
    if (action.length) elements.push({ type: 'action', text: action.join('\n') });
    action = [];
  };
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    const prevBlank = i === 0 || lines[i - 1]!.trim() === '';
    const next = lines[i + 1]?.trim() ?? '';
    if (!line) {
      flush();
      continue;
    }
    if (/^#/.test(line) || /^={3,}$/.test(line) || /^>.*<$/.test(line)) continue;
    if (/^=(?!=)/.test(line)) {
      flush();
      elements.push({ type: 'synopsis', text: line.slice(1).trim() });
      continue;
    }
    if (prevBlank && (HEADING.test(line) || /^\.[^.]/.test(line))) {
      flush();
      elements.push({ type: 'heading', text: line });
      continue;
    }
    if (/^>/.test(line) || (prevBlank && /^[A-Z0-9 .'’-]+TO:$/.test(line))) {
      flush();
      continue;
    }
    const upper = line.replace(EXTENSION, '').replace(/\^\s*$/, '');
    const isCue =
      prevBlank &&
      next !== '' &&
      (line.startsWith('@') || (/\p{Lu}/u.test(upper) && upper === upper.toUpperCase() && !/^!/.test(line)));
    if (isCue) {
      flush();
      elements.push({ type: 'character', text: line });
      for (i = i + 1; i < lines.length && lines[i]!.trim() !== ''; i++) {
        const d = lines[i]!.trim();
        if (/^\(.*\)$/.test(d)) elements.push({ type: 'parenthetical', text: d });
        else elements.push({ type: 'dialogue', text: d });
      }
      i--;
      continue;
    }
    action.push(line.replace(/^!/, ''));
  }
  flush();
  return { title, scenes: buildScenes(elements) };
}

function decodeXml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const FDX_TYPES: Record<string, Element['type']> = {
  'Scene Heading': 'heading',
  Action: 'action',
  General: 'action',
  Shot: 'action',
  Character: 'character',
  Parenthetical: 'parenthetical',
  Dialogue: 'dialogue',
};

function fdxParagraphs(xml: string): { type: string; text: string }[] {
  const out: { type: string; text: string }[] = [];
  for (const m of xml.matchAll(/<Paragraph\b([^>]*)>([\s\S]*?)<\/Paragraph>/g)) {
    const type = /\bType="([^"]*)"/.exec(m[1]!)?.[1] ?? 'Action';
    const text = [...m[2]!.matchAll(/<Text\b[^>]*>([\s\S]*?)<\/Text>/g)]
      .map((t) => decodeXml(t[1]!))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) out.push({ type, text });
  }
  return out;
}

/** Final Draft XML: the paragraphs of `<Content>`; the title is the first paragraph of the title page. */
export function parseFdx(xml: string): ParsedScript {
  if (!/<FinalDraft\b/.test(xml)) throw new Error('not a Final Draft document');
  const content = /<Content>([\s\S]*?)<\/Content>/.exec(xml)?.[1] ?? '';
  const titlePage = /<TitlePage>([\s\S]*?)<\/TitlePage>/.exec(xml)?.[1] ?? '';
  const elements: Element[] = [];
  for (const p of fdxParagraphs(content)) {
    const type = FDX_TYPES[p.type];
    if (type) elements.push({ type, text: p.text });
  }
  return { title: fdxParagraphs(titlePage)[0]?.text ?? '', scenes: buildScenes(elements) };
}

/** A text line of a PDF page, in points from the page's top left. */
export interface PdfLine {
  page: number;
  x: number;
  y: number;
  text: string;
}

/**
 * Rebuilds Fountain from the text lines of a PDF screenplay: a blank line wherever the vertical gap is larger than
 * a line, page furniture (page numbers, MORE, CONTINUED) dropped, scene numbers around headings removed.
 */
export function fountainFromPdfLines(lines: PdfLine[]): string {
  const out: string[] = [];
  const sorted = [...lines]
    .map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.text)
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const gaps = sorted
    .slice(1)
    .map((l, i) => (l.page === sorted[i]!.page ? l.y - sorted[i]!.y : 0))
    .filter((g) => g > 0.5)
    .sort((a, b) => a - b);
  const lineHeight = gaps[Math.floor(gaps.length * 0.25)] ?? 12;
  let prev: (typeof sorted)[number] | null = null;
  for (const l of sorted) {
    let text = l.text;
    if (/^\d+\.?$/.test(text) || /^\(?(?:MORE|CONTINUED)\)?:?$/i.test(text) || /^\(CONT['’]?D\)$/i.test(text))
      continue;
    if (/^CONTINUED:?(?:\s*\(\d+\))?$/i.test(text)) continue;
    // Scene numbers on both sides of a heading: "12 INT. ROOM - DAY 12"
    const numbered = /^(\d+[A-Z]?)\s+(.*?)(?:\s+\1)?$/.exec(text);
    if (numbered && HEADING.test(numbered[2]!)) text = numbered[2]!;
    if (prev && (l.page !== prev.page || l.y - prev.y > lineHeight * 1.6)) out.push('');
    if (prev && l.page === prev.page && Math.abs(l.y - prev.y) < 0.5 && out.length) {
      out[out.length - 1] = `${out[out.length - 1]} ${text}`;
    } else out.push(text);
    prev = l;
  }
  return `${out.join('\n')}\n`;
}

/** Picks the parser from the file name, MIME type or the first bytes. */
export function detectScriptFormat(name: string, mime: string, head: string): ScriptFormat {
  if (/\.pdf$/i.test(name) || mime === 'application/pdf' || head.startsWith('%PDF')) return 'pdf';
  if (/\.fdx$/i.test(name) || /<FinalDraft\b/.test(head)) return 'fdx';
  return 'fountain';
}

/** Seconds of screen time: one page (55 lines) a minute, at least 10 s a scene. */
export function sceneSeconds(scene: Pick<ParsedScene, 'lines'>): number {
  return Math.max(10, Math.round((scene.lines * 60) / 55));
}

/** The screenwriter's shape without the limits of one LLM answer (a feature has hundreds of scenes). */
const ImportedOutputSchema = ScreenplayGenerateOutputSchema.extend({
  characters: ScreenplayGenerateOutputSchema.shape.characters.element.array().max(60),
  outline: ScreenplayGenerateOutputSchema.shape.outline.element.array().min(1).max(2000),
  scenes: ScreenplayGenerateOutputSchema.shape.scenes.element.array().min(1).max(2000),
});

/**
 * The imported script in the screenwriter's output shape, so it goes through the same normalization (characters,
 * locations and outline) as a generated screenplay. The speaker with the most lines is the protagonist.
 */
export function importedToScreenplayOutput(
  script: ParsedScript,
  fallbackTitle: string,
): ScreenplayGenerateOutput {
  if (!script.scenes.length) throw new Error('no scene found');
  const counts = new Map<string, number>();
  for (const s of script.scenes)
    for (const d of s.dialogue) counts.set(d.character, (counts.get(d.character) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const characters = ranked.slice(0, 60).map(([name, n], i) => ({
    name: titleCase(name),
    role: i === 0 ? 'protagonist' : n >= 3 ? 'supporting' : 'minor',
    summary: '',
  }));
  const named = (n: string) => titleCase(n);
  return ImportedOutputSchema.parse({
    title: script.title || fallbackTitle,
    characters,
    locations: [...new Set(script.scenes.map((s) => s.location).filter(Boolean))].map((name) => ({
      name,
      description: '',
    })),
    props: [],
    outline: script.scenes.map((s) => ({
      title: s.heading,
      summary: s.summary || s.action.split('\n')[0]?.slice(0, 300) || s.heading,
      estDurationSec: sceneSeconds(s),
    })),
    scenes: script.scenes.map((s, i) => ({
      beatIndex: i,
      heading: s.heading,
      location: s.location,
      timeOfDay: s.timeOfDay,
      summary: s.summary || s.action.split('\n')[0]?.slice(0, 300) || '',
      action: s.action,
      dialogue: s.dialogue.map((d) => ({
        character: named(d.character),
        line: d.line,
        ...(d.parenthetical ? { parenthetical: d.parenthetical } : {}),
      })),
      characters: s.characters.map(named),
      props: [],
      estDurationSec: sceneSeconds(s),
    })),
    ended: true,
  });
}
