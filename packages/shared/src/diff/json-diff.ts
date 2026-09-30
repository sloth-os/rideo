import type { JsonDiffOp } from '../schemas/vcs';
import { jsonEqual } from '../util/canonical-json';

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function idOf(v: unknown): string | undefined {
  return isObject(v) && typeof v.id === 'string' ? v.id : undefined;
}

/**
 * Structural JSON diff as JSON-pointer operations. Arrays whose elements all carry an `id` are matched
 * by id (pointer segment `[id=<id>]`), so reordering shows as index changes, not a full rewrite.
 */
export function jsonDiff(
  before: unknown,
  after: unknown,
  pointer = '',
  out: JsonDiffOp[] = [],
  maxOps = 500,
): JsonDiffOp[] {
  if (out.length >= maxOps) return out;
  if (jsonEqual(before, after)) return out;
  if (Array.isArray(before) && Array.isArray(after)) {
    const allIds = [...before, ...after].every((v) => idOf(v) !== undefined);
    if (allIds) {
      const bMap = new Map(before.map((v) => [idOf(v)!, v]));
      const aMap = new Map(after.map((v) => [idOf(v)!, v]));
      for (const [id, v] of bMap)
        if (!aMap.has(id)) out.push({ op: 'remove', pointer: `${pointer}/[id=${id}]`, before: v });
      for (const [id, v] of aMap) {
        if (!bMap.has(id)) out.push({ op: 'add', pointer: `${pointer}/[id=${id}]`, after: v });
        else jsonDiff(bMap.get(id), v, `${pointer}/[id=${id}]`, out, maxOps);
      }
      return out;
    }
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      if (i >= after.length) out.push({ op: 'remove', pointer: `${pointer}/${i}`, before: before[i] });
      else if (i >= before.length) out.push({ op: 'add', pointer: `${pointer}/${i}`, after: after[i] });
      else jsonDiff(before[i], after[i], `${pointer}/${i}`, out, maxOps);
    }
    return out;
  }
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const p = `${pointer}/${escapePointer(key)}`;
      if (!(key in after) || after[key] === undefined) {
        if (before[key] !== undefined) out.push({ op: 'remove', pointer: p, before: before[key] });
      } else if (!(key in before) || before[key] === undefined) {
        out.push({ op: 'add', pointer: p, after: after[key] });
      } else {
        jsonDiff(before[key], after[key], p, out, maxOps);
      }
    }
    return out;
  }
  out.push({ op: 'replace', pointer: pointer || '/', before, after });
  return out;
}
