/** Formats seconds as H:MM:SS or M:SS (timecodes in UI, prompts and logs). */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm}:${String(sec).padStart(2, '0')}` : `${mm}:${String(sec).padStart(2, '0')}`;
}

/** Frame-accurate timecode HH:MM:SS:FF. */
export function formatTimecode(totalSec: number, fps: number): string {
  const frames = Math.max(0, Math.round(totalSec * fps));
  const f = frames % fps;
  const s = Math.floor(frames / fps);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}:${pad(f)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Bytes as KB, MB, GB (decimal units, one decimal from MB up). */
export function formatBytes(bytes: number): string {
  const n = Math.max(0, bytes);
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
