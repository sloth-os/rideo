import type { Character } from '../schemas/character';
import type { Screenplay } from '../schemas/screenplay';
import { formatDuration } from '../util/time';

/** Human-readable rendering of screenplay.json (materialized as screenplay.md on WebDAV). */
export function renderScreenplayMarkdown(sp: Screenplay, characters: Record<string, Character> = {}): string {
  const out: string[] = [];
  out.push(`# ${sp.title || 'Untitled'}`, '');
  if (sp.logline) out.push(`> ${sp.logline}`, '');
  const meta = [sp.genre && `**Genre:** ${sp.genre}`, sp.tone && `**Tone:** ${sp.tone}`].filter(Boolean);
  if (meta.length) out.push(meta.join(' · '), '');
  if (sp.synopsis) out.push('## Synopsis', '', sp.synopsis, '');
  const style = [
    ['Visual', sp.style.visual],
    ['Palette', sp.style.palette],
    ['Camera', sp.style.camera],
    ['Lighting', sp.style.lighting],
  ].filter(([, v]) => v);
  if (style.length) out.push('## Style bible', '', ...style.map(([k, v]) => `- **${k}:** ${v}`), '');
  const cast = Object.values(characters);
  if (cast.length) {
    out.push('## Cast', '');
    for (const c of cast) out.push(`- **${c.name}** (${c.role})${c.lock.locked ? ' 🔒' : ''} — ${c.summary}`);
    out.push('');
  }
  if (sp.outline.length) {
    out.push('## Outline', '');
    for (const b of [...sp.outline].sort((a, b) => a.index - b.index)) {
      out.push(
        `${b.index + 1}. ${b.title ? `**${b.title}** — ` : ''}${b.summary} _(${formatDuration(b.estDurationSec)})_${b.sceneId ? ' ✓' : ''}`,
      );
    }
    out.push('');
  }
  out.push('## Scenes', '');
  for (const s of [...sp.scenes].sort((a, b) => a.index - b.index)) {
    out.push(`### ${s.index + 1}. ${s.heading.toUpperCase()}`, '');
    if (s.summary) out.push(`_${s.summary}_`, '');
    if (s.action) out.push(s.action, '');
    for (const d of s.dialogue) {
      const name = (d.characterId && characters[d.characterId]?.name) || d.character;
      out.push(
        `**${name.toUpperCase()}**${d.parenthetical ? ` _(${d.parenthetical})_` : ''}`,
        `: ${d.line}`,
        '',
      );
    }
  }
  return `${out.join('\n').trim()}\n`;
}
