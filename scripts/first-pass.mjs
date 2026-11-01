#!/usr/bin/env node
/**
 * Measures the first pass of a Rideo build on real models (docs/design/first-pass.md#measuring-the-first-pass): a
 * project made from a brief with every automatic fix off, on autopilot, past every gate that does not pass (as a
 * person continuing anyway would), so that each step is made once and reviewed once. Records the first round of every
 * review: the overall score, every dimension and the issues, and prints them against the bar of 8.
 *
 *   RIDEO_API_TOKEN=… node scripts/first-pass.mjs --base http://127.0.0.1:8790 --brief brief.txt --until storyboard
 *
 * Node 24, no dependencies.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:8787' },
    brief: { type: 'string' },
    title: { type: 'string', default: 'First pass' },
    attach: { type: 'string', multiple: true, default: [] },
    target: { type: 'string', default: '60' },
    pilot: { type: 'string', default: '20' },
    scenes: { type: 'string', default: '3' },
    until: { type: 'string', default: 'storyboard' },
    settings: { type: 'string' },
    project: { type: 'string' },
    out: { type: 'string' },
    poll: { type: 'string', default: '20' },
    timeout: { type: 'string', default: '21600' },
  },
});

/** The steps the measurement can stop after, in the order the autopilot reaches them. */
const UNTIL = ['screenplay', 'cast', 'storyboard', 'pilot'];
const BAR = 8;
const NOTE =
  'First-pass measurement: continue without fixes (docs/design/first-pass.md#measuring-the-first-pass).';
if (!UNTIL.includes(o.until)) throw new Error(`--until must be one of ${UNTIL.join(', ')}`);
const base = o.base.replace(/\/$/, '');
const token = process.env.RIDEO_API_TOKEN ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

async function api(method, path, body) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${base}/api${path}`, { method, headers, body: payload });
      const text = await res.text();
      if (res.ok) return text ? JSON.parse(text) : null;
      // The storage answers 5xx under load for a while: try again
      if (res.status >= 500 && attempt < 5) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      const err = new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    } catch (err) {
      if (err.status || attempt >= 5) throw err;
      await sleep(3000 * (attempt + 1));
    }
  }
}

const merge = (a, b) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b ?? a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = merge(a?.[k], v);
  return out;
};

/** A review's first round as the report keeps it. */
function record(step, r, extra = {}) {
  const scores = r.scores ?? {};
  const scored = Object.entries(scores).filter(([, v]) => typeof v === 'number');
  const score = r.verdict?.score ?? r.overall ?? null;
  return {
    step,
    ...extra,
    score,
    scores,
    lowest: scored.filter(([, v]) => v < BAR).map(([k, v]) => `${k} ${v}`),
    atBar:
      score !== null &&
      score >= BAR &&
      scored.every(([, v]) => v >= BAR) &&
      !r.issues?.some((i) => i.severity === 'critical'),
    passed: r.verdict?.passed ?? null,
    model: r.model ?? null,
    summary: (r.summary ?? '').slice(0, 2000),
    issues: (r.issues ?? []).map((i) => ({
      dimension: i.dimension,
      severity: i.severity,
      at: i.shot ?? i.scene ?? i.characterId ?? i.elementId ?? null,
      title: i.title,
      detail: (i.detail ?? '').slice(0, 400),
    })),
  };
}

const byIndex = (a, b) => a.index - b.index;
const reviewed = new Set();
const report = {
  base,
  startedAt: new Date().toISOString(),
  until: o.until,
  project: o.project ?? null,
  settings: null,
  steps: [],
  takes: [],
  actions: [],
};

async function start() {
  if (o.project) return o.project;
  if (!o.brief) throw new Error('--brief <file> (or --project <id>) is required');
  const prompt = (await readFile(o.brief, 'utf8')).trim();
  const settings = merge(
    {
      targetDurationSec: Number(o.target),
      pilotDurationSec: Number(o.pilot),
      autopilot: true,
      // Every automatic fix off: each step is made once and reviewed once
      review: { maxRounds: 0, sceneFixes: 0 },
      consistency: { maxAttempts: 1 },
      storyboard: { enabled: true, scenes: Number(o.scenes), production: true },
    },
    o.settings ? JSON.parse(o.settings) : undefined,
  );
  const p = await api('POST', '/projects', { kind: 'story', title: o.title, brief: { prompt }, settings });
  log('project', p.id);
  const ids = [];
  for (const file of o.attach) {
    const form = new FormData();
    form.set('kind', 'image');
    form.set('role', 'reference');
    form.set('name', basename(file, extname(file)));
    form.set('file', new Blob([await readFile(file)]), basename(file));
    ids.push((await api('POST', `/projects/${p.id}/uploads`, form)).id);
  }
  if (ids.length) await api('PATCH', `/projects/${p.id}`, { brief: { prompt, attachmentResourceIds: ids } });
  await api('POST', `/projects/${p.id}/workflow/approve`, { gate: 'brief_submitted' });
  return p.id;
}

const act = async (what, fn) => {
  try {
    const out = await fn();
    report.actions.push({ at: new Date().toISOString(), what });
    log(what);
    return out;
  } catch (err) {
    log(`${what}: ${err.message}`);
    return null;
  }
};

/** Reviews run again after their job failed, by stage: twice at most. */
const rerun = {};

/** Takes the project past a gate whose review did not pass, as a person continuing anyway would. */
async function unblock(pid, d, jobs) {
  const stage = d.project.workflow.stage;
  const approvals = d.project.workflow.approvals ?? {};
  const busy = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  const r = d.aiReviews?.[stage === 'edit' ? 'cut' : stage];
  // A review whose job failed (the provider answering 502 or 504 for a while) is run again, as a person would
  if (r?.status === 'failed' && !busy && (rerun[r.stage] ?? 0) < 2) {
    rerun[r.stage] = (rerun[r.stage] ?? 0) + 1;
    await act(
      `run the ${r.stage} review again after it failed (${String(r.error ?? '').slice(0, 120)})`,
      () => api('POST', `/projects/${pid}/ai-reviews/${r.stage}/run`, {}),
    );
    return;
  }
  const failed = r?.status === 'succeeded' && r.verdict && !r.verdict.passed && !r.override;
  if (failed)
    await act(`continue past the ${r.stage} review`, () =>
      api('POST', `/projects/${pid}/ai-reviews/${r.stage}/override`, { note: NOTE }),
    );
  const gate = { screenplay: 'screenplay_approved', cast: 'cast_locked', storyboard: 'storyboard_approved' }[
    stage
  ];
  const overridden = r?.status === 'succeeded' && (r.override || failed);
  if (!gate || approvals[gate] || !overridden || busy) return;
  if (stage === 'cast') {
    // What the review's pass would have done: approve the references, lock the cast and the places and props
    for (const [kind, list] of [
      ['characters', Object.values(d.characters)],
      ['elements', Object.values(d.elements)],
    ])
      for (const x of list) {
        if (x.lock?.locked || !x.references?.length) continue;
        for (const ref of x.references)
          if (!ref.approved)
            await act(`approve ${x.name} ${ref.view}`, () =>
              api('PATCH', `/projects/${pid}/${kind}/${x.id}/references/${ref.id}`, { approved: true }),
            );
        await act(`lock ${x.name}`, () => api('POST', `/projects/${pid}/${kind}/${x.id}/lock`));
      }
  }
  if (stage === 'storyboard')
    await act('approve every frame', () => api('POST', `/projects/${pid}/storyboard/approve-all`, {}));
  await act(`approve ${gate}`, () => api('POST', `/projects/${pid}/workflow/approve`, { gate }));
}

/** Approves the pilot clip when its scene was reviewed, as a person would when its gate does not hold. */
async function approvePilot(pid, d, jobs) {
  if (
    d.project.workflow.stage !== 'pilot' ||
    jobs.some((j) => j.status === 'queued' || j.status === 'running')
  )
    return;
  const pilot = Object.values(d.clips).sort(byIndex)[0];
  if (!pilot || pilot.status === 'approved' || !pilot.shots.every((s) => s.selectedTakeId)) return;
  if (pilot.shots.length >= 2 && pilot.review?.status !== 'succeeded') return;
  const ok = await act('approve the pilot clip', () =>
    api('POST', `/projects/${pid}/clips/${pilot.id}/approve`),
  );
  if (!ok) {
    const takes = pilot.shots.map((s) => ({ clipId: pilot.id, shotId: s.id, takeId: s.selectedTakeId }));
    await act('override the pilot takes', () =>
      api('POST', `/projects/${pid}/takes/override`, { takes, reason: NOTE }),
    );
    await act('approve the pilot clip', () => api('POST', `/projects/${pid}/clips/${pilot.id}/approve`));
  }
  await act('approve pilot_approved', () =>
    api('POST', `/projects/${pid}/workflow/approve`, { gate: 'pilot_approved' }),
  );
}

/** Records every first round not recorded yet: the stage reviews, each scene's storyboard and scene review, takes. */
function collect(d) {
  for (const [name, r] of Object.entries(d.aiReviews ?? {})) {
    if (r?.status !== 'succeeded' || r.round !== 1) continue;
    const key = `review:${name}:${r.jobId}`;
    if (reviewed.has(key)) continue;
    reviewed.add(key);
    report.steps.push(record(name, r, { jobId: r.jobId }));
    log(`${name} review, round 1: ${r.verdict?.score}`, JSON.stringify(r.scores));
  }
  for (const c of Object.values(d.clips).sort(byIndex)) {
    const scene = c.index + 1;
    const b = c.boardReview;
    if (b?.status === 'succeeded' && b.round === 1 && !reviewed.has(`board:${c.id}:${b.jobId}`)) {
      reviewed.add(`board:${c.id}:${b.jobId}`);
      report.steps.push(record('scene storyboard', b, { scene }));
      log(`scene ${scene} storyboard, round 1: ${b.verdict?.score}`, JSON.stringify(b.scores));
    }
    const v = c.review;
    if (v?.status === 'succeeded' && v.round === 1 && !reviewed.has(`scene:${c.id}:${v.subject}`)) {
      reviewed.add(`scene:${c.id}:${v.subject}`);
      report.steps.push(record('scene', v, { scene, watched: v.watched, heard: v.heard }));
      log(`scene ${scene} watched, round 1: ${v.overall}`, JSON.stringify(v.scores));
    }
    for (const s of [...c.shots].sort(byIndex)) {
      const first = [...s.takes].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      const w = first?.consistency?.quality?.watch;
      if (!first || !w || reviewed.has(`take:${first.id}`)) continue;
      reviewed.add(`take:${first.id}`);
      report.takes.push({
        scene,
        shot: s.index + 1,
        overall: w.overall ?? null,
        passed: w.passed ?? null,
        identity: first.consistency?.status ?? null,
        issues: (w.issues ?? []).map((i) => `${i.severity}: ${i.title}`).slice(0, 10),
      });
    }
  }
}

function done(d) {
  const has = (step) => report.steps.some((s) => s.step === step);
  if (o.until === 'screenplay') return has('screenplay');
  if (o.until === 'cast') return has('cast');
  if (o.until === 'storyboard') return has('storyboard');
  const pilot = Object.values(d.clips).sort(byIndex)[0];
  if (!pilot?.shots.length || !pilot.shots.every((s) => s.selectedTakeId)) return false;
  return (
    pilot.shots.length < 2 || report.steps.some((s) => s.step === 'scene' && s.scene === pilot.index + 1)
  );
}

function table() {
  const rows = report.steps.map((s) => [
    s.scene ? `${s.step} ${s.scene}` : s.step,
    s.score === null ? '–' : s.score.toFixed(1),
    s.atBar ? 'yes' : 'no',
    s.lowest.join(', ') || '–',
  ]);
  const watched = report.takes.filter((t) => typeof t.overall === 'number');
  if (watched.length)
    rows.push([
      `first takes (${watched.length})`,
      (watched.reduce((n, t) => n + t.overall, 0) / watched.length).toFixed(1),
      watched.every((t) => t.overall >= BAR) ? 'yes' : 'no',
      `${watched.filter((t) => t.overall >= BAR).length} of ${watched.length} at ${BAR} or more`,
    ]);
  const head = ['Step', 'Round 1', `Every score ≥ ${BAR}`, `Under ${BAR}`];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const pid = await start();
report.project = pid;
const deadline = Date.now() + Number(o.timeout) * 1000;
const save = async () => {
  report.updatedAt = new Date().toISOString();
  if (o.out) await writeFile(o.out, JSON.stringify(report, null, 2));
};
for (;;) {
  const st = await api('GET', `/projects/${pid}/state`);
  const d = st.docs;
  report.settings ??= d.project.settings;
  const jobs = st.jobs ?? [];
  collect(d);
  await save();
  if (done(d)) break;
  if (Date.now() > deadline) {
    log('timed out');
    break;
  }
  await unblock(pid, d, jobs);
  await approvePilot(pid, d, jobs);
  await sleep(Number(o.poll) * 1000);
}
report.finishedAt = new Date().toISOString();
// What the first pass cost (docs/design/observability.md#usage-ledger)
const usage = (await api('GET', `/projects/${pid}/insights`).catch(() => null))?.usage?.totals;
if (usage)
  report.usage = {
    costUsd: usage.costUsd,
    images: usage.images,
    videoSeconds: usage.videoSeconds,
    llmCalls: usage.llmCalls,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
  };
await save();
console.log(table());
if (report.usage)
  console.log(
    `\nCost: $${report.usage.costUsd.toFixed(2)} (${report.usage.images} images, ${report.usage.videoSeconds} s of video, ${report.usage.llmCalls} model calls)`,
  );
