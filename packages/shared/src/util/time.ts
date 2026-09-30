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
