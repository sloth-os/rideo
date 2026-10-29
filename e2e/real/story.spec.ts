import { expect, test } from '@playwright/test';
import { ELEMENT_VIEWS, elementsInUse } from '@rideo/shared';
import { Api, projectIdFrom } from '../support/api';
import { readRealEnv } from './env';
import { counters, drawLighthouse, filmSea, REAL_PROJECT_SETTINGS } from './support';

const env = readRealEnv(process.env);
const MINUTES = 60_000;
/** Real jobs take minutes: no need to ask more often. */
const POLL = 2000;

const BRIEF =
  'A ten-second film. Ines, a lighthouse keeper in her sixties with short grey hair and a yellow raincoat, climbs ' +
  'into the lantern room at dusk and lights the great lamp while the sea rolls below. One character and one ' +
  'location, the lantern room at the top of the lighthouse; nobody else.';

type Job = { id: string; kind: string; status: string };

test('a brief with a picture and a video → screenplay → locked cast → pilot clip, on the real models', async ({
  page,
  request,
}, testInfo) => {
  const api = new Api(request);
  const before = await counters(request);
  const newCalls = async (task: string) =>
    (await counters(request))('rideo_llm_calls_total', { status: 'ok', task }) -
    before('rideo_llm_calls_total', { status: 'ok', task });
  const jobOf = async (pid: string, kind: string) => {
    let job: Job | undefined;
    await expect
      .poll(async () => {
        job = (await api.call<Job[]>('GET', `/projects/${pid}/jobs`)).find((j) => j.kind === kind);
        return job?.id;
      })
      .toBeTruthy();
    return job!;
  };

  // The brief: the idea, then a picture and a video attached to it
  await page.goto('/');
  await page.getByTestId('new-story').click();
  await page.getByLabel('Title').fill('Real models: the keeper');
  await page.getByRole('textbox', { name: /^Idea/ }).fill(BRIEF);
  await page.getByTestId('create-project-submit').click();
  await expect(page).toHaveURL(/\/p\/prj_[0-9a-z]+\/story$/);
  const pid = projectIdFrom(page.url());
  await api.call('PATCH', `/projects/${pid}`, { settings: REAL_PROJECT_SETTINGS });
  await page
    .getByTestId('brief-attach')
    .setInputFiles([
      drawLighthouse(testInfo.outputPath('lighthouse.png')),
      filmSea(testInfo.outputPath('sea.mp4')),
    ]);
  await expect
    .poll(async () => {
      const { docs } = await api.call('GET', `/projects/${pid}/state`);
      return docs.project.brief.attachmentResourceIds.map((id: string) => docs.resources[id]?.kind).sort();
    })
    .toEqual(['image', 'video']);

  // The screenplay: the vision model describes the picture and frames of the video, then writes the film
  await page.getByTestId('generate-screenplay').click();
  await api.waitJob(pid, (await jobOf(pid, 'screenplay.generate')).id, 15 * MINUTES, POLL);
  await expect(page.getByTestId('scenes')).toBeVisible();
  expect(await newCalls('media.describe')).toBe(1);
  expect(await newCalls('screenplay.generate')).toBe(1);
  let { docs } = await api.call('GET', `/projects/${pid}/state`);
  expect(docs.screenplay.title).not.toBe('');
  expect(docs.screenplay.scenes.length).toBeGreaterThan(0);
  expect(docs.screenplay.scenes[0].action).not.toBe('');
  const cast = Object.values<{ id: string; name: string }>(docs.characters);
  expect(cast.length).toBeGreaterThan(0);
  // The AI review of the screenplay runs on the real text model (docs/design/ai-review.md): a verdict comes back
  // with scores; a failing one is continued anyway, since its score depends on the story the model wrote
  await api.waitJob(pid, (await jobOf(pid, 'screenplay.review')).id, 20 * MINUTES, POLL);
  expect(await newCalls('screenplay.review')).toBeGreaterThanOrEqual(1);
  const review = (await api.call('GET', `/projects/${pid}/state`)).docs.aiReviews.screenplay;
  expect(review).toMatchObject({ status: 'succeeded' });
  expect(review.verdict.score).toBeGreaterThan(0);
  expect(Object.values(review.scores).filter((v) => typeof v === 'number').length).toBeGreaterThanOrEqual(6);
  const panel = page.getByTestId('ai-review-screenplay');
  if ((await panel.getAttribute('data-state')) === 'failed') {
    page.once('dialog', (d) => d.accept('real-model run'));
    await panel.getByTestId('override-ai-review').click();
    await expect(panel).toHaveAttribute('data-state', 'overridden');
  }
  ({ docs } = await api.call('GET', `/projects/${pid}/state`));
  await expect(page.getByTestId('approve-screenplay')).toBeEnabled();
  await page.getByTestId('approve-screenplay').click();

  // The cast: one front reference per character and one view per location or prop in use, from the image model
  const elements = elementsInUse(docs);
  const refJobs = [
    ...(await Promise.all(
      cast.map((c) =>
        api.call<Job>('POST', `/projects/${pid}/characters/${c.id}/references/generate`, {
          views: ['front'],
        }),
      ),
    )),
    ...(await Promise.all(
      elements.map((e) =>
        api.call<Job>('POST', `/projects/${pid}/elements/${e.id}/references/generate`, {
          views: [ELEMENT_VIEWS[e.kind][0]],
        }),
      ),
    )),
  ];
  await Promise.all(refJobs.map((j) => api.waitJob(pid, j.id, 15 * MINUTES, POLL)));
  ({ docs } = await api.call('GET', `/projects/${pid}/state`));
  for (const c of Object.values<any>(docs.characters)) {
    expect(c.references).toHaveLength(1);
    for (const r of c.references)
      await api.call('PATCH', `/projects/${pid}/characters/${c.id}/references/${r.id}`, { approved: true });
    await api.call('POST', `/projects/${pid}/characters/${c.id}/lock`);
  }
  for (const e of elementsInUse(docs)) {
    expect(docs.elements[e.id].references).toHaveLength(1);
    for (const r of docs.elements[e.id].references)
      await api.call('PATCH', `/projects/${pid}/elements/${e.id}/references/${r.id}`, { approved: true });
    await api.call('POST', `/projects/${pid}/elements/${e.id}/lock`);
  }
  await page.getByTestId('nav-cast').click();
  await expect(page.getByTestId('reference')).toHaveCount(cast.length);
  await expect(page.getByTestId('unlock-character')).toHaveCount(cast.length);
  for (const gate of ['cast_locked', 'resources_ready', 'storyboard_approved'])
    await api.call('POST', `/projects/${pid}/workflow/approve`, { gate });

  // The pilot: the vision model plans the shots; each shot gets a keyframe from the image model, judged by the
  // vision model against the references, then a video from the video model, judged on its frames
  await page.getByTestId('nav-clips').click();
  await page.getByTestId('plan-generate-scene').first().click();
  await api.waitJob(pid, (await jobOf(pid, 'clip.plan')).id, 10 * MINUTES, POLL);
  await api.waitJob(pid, (await jobOf(pid, 'clip.generate')).id, 40 * MINUTES, POLL);
  expect(await newCalls('clip.plan')).toBe(1);
  ({ docs } = await api.call('GET', `/projects/${pid}/state`));
  const [clip] = Object.values<any>(docs.clips);
  expect(clip.shots.length).toBeGreaterThan(0);
  const takes = clip.shots.map((s: any) => {
    expect(s.takes.length, `shot ${s.index + 1} has a take (${s.lastError ?? 'no error'})`).toBeGreaterThan(
      0,
    );
    // the planner's lengths are the ones the gateway's catalog gives for the model
    expect(s.durationSec).toBe(env.VIDEO_GEN_DURATION_SEC);
    return s.takes.at(-1);
  });
  for (const take of takes) {
    // The vision model judged: a verdict, not `unverified` (which is what a failed judge call leaves)
    expect(take.consistency.judge).toBe(`vision-llm:${env.VISION_MODEL}`);
    expect(['passed', 'failed'], take.consistency.note).toContain(take.consistency.status);
    // A cut starts from a keyframe of the image model; a continuous shot from the last frame of the one before; a
    // later shot of a multi-shot sequence from the sequence itself (docs/design/multi-shot.md)
    const inSequence = (take.request.multiShot?.index ?? 0) > 0;
    if (take.request.firstFrameSource !== 'previous_shot' && !inSequence) {
      expect(take.keyframe).not.toBeNull();
      expect(take.request.imageModel).toBe(env.IMAGE_MODEL);
    }
  }
  expect(
    takes.flatMap((t: any) => t.consistency.characters).length,
    "the vision model's verdicts on the characters",
  ).toBeGreaterThan(0);
  expect(await newCalls('consistency.judge')).toBeGreaterThan(0);
  const filmed = takes.filter((t: any) => t.video);
  expect(filmed.length, 'a take with a video from the video model').toBeGreaterThan(0);
  for (const take of filmed) {
    expect(take.request.videoModel).toBe(env.VIDEO_GEN_MODEL);
    if (take.request.multiShot) {
      // a segment of a sequence: the first starts from its keyframe, and each lasts what the model cut (2-5 s on Wan 3.0)
      expect(take.request.firstFrameSource).toBe(take.request.multiShot.index === 0 ? 'keyframe' : 'none');
      expect(take.video.durationSec).toBeGreaterThan(1);
    } else {
      expect(['keyframe', 'previous_shot']).toContain(take.request.firstFrameSource);
      expect(take.video.durationSec).toBeGreaterThan(env.VIDEO_GEN_DURATION_SEC - 1.5);
    }
    expect(take.video.width).toBeGreaterThan(0);
    // Signed with the keyframe as its ingredient, in the format the image model returned (Seedream: JPEG)
    if (take.keyframe) expect(take.contentCredentials).toMatchObject({ ingredients: 1 });
  }
  const after = await counters(request);
  // one task per take, or one for every take of a sequence
  expect(
    after('rideo_gateway_tasks_total', { modality: 'video', status: 'succeeded' }),
  ).toBeGreaterThanOrEqual(new Set(filmed.map((t: any) => t.gatewayTaskIds.at(-1))).size);
  // The takes are in the clip on the page, each with its evidence
  const shown = clip.shots.reduce((n: number, s: any) => n + s.takes.length, 0);
  await expect(page.getByTestId('clips')).toBeVisible();
  await expect(page.locator('[data-entity^="take:"]')).toHaveCount(shown);
  await expect(page.getByTestId('take-evidence')).toHaveCount(shown);
});
