/** Minimal Prometheus registry (counters, gauges, histograms with labels) — text exposition format. */
type Labels = Record<string, string | number>;

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map(
      (k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
    )
    .join(',');
}

interface Metric {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  render(): string[];
}

export class Counter implements Metric {
  readonly type = 'counter' as const;
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }
  render(): string[] {
    return [...this.values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ''} ${v}`);
  }
}

export class Gauge implements Metric {
  readonly type = 'gauge' as const;
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(labels: Labels, value: number): void {
    this.values.set(key(labels), value);
  }
  render(): string[] {
    return [...this.values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ''} ${v}`);
  }
}

export class Histogram implements Metric {
  readonly type = 'histogram' as const;
  private readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[] = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800],
  ) {}
  observe(labels: Labels, value: number): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.bounds.forEach((b, i) => {
      if (value <= b) s!.buckets[i]!++;
    });
    s.sum += value;
    s.count++;
  }
  render(): string[] {
    const out: string[] = [];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : '';
      for (const [i, b] of this.bounds.entries())
        out.push(`${this.name}_bucket{${sep}le="${b}"} ${s.buckets[i]}`);
      out.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      out.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      out.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return out;
  }
}

export class Metrics {
  private readonly all: Metric[] = [];
  readonly jobs = this.add(new Counter('rideo_jobs_total', 'Jobs finished by kind and status'));
  readonly jobDuration = this.add(new Histogram('rideo_job_duration_seconds', 'Job run time by kind'));
  readonly gatewayTasks = this.add(
    new Counter('rideo_gateway_tasks_total', 'mm-gateway tasks by modality and status'),
  );
  readonly llmCalls = this.add(new Counter('rideo_llm_calls_total', 'LLM task calls by task and status'));
  readonly consistency = this.add(new Counter('rideo_consistency_checks_total', 'Consistency gate outcomes'));
  readonly watermark = this.add(
    new Counter('rideo_watermark_operations_total', 'Watermark embeds and detections'),
  );
  readonly storageLatency = this.add(
    new Histogram(
      'rideo_storage_seconds',
      'WebDAV operation latency',
      [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    ),
  );
  readonly liveSessions = this.add(new Gauge('rideo_live_sessions', 'Connected live sessions'));
  /** Accounts (docs/design/accounts.md): sign-ins, token use and denials. */
  readonly auth = this.add(
    new Counter('rideo_auth_total', 'Sign-ins, token use and denials by event and outcome'),
  );
  /** Web Push deliveries and subscriptions by outcome (docs/design/pwa.md). */
  readonly push = this.add(
    new Counter('rideo_push_total', 'Web Push: devices subscribed and messages sent, gone or failed'),
  );
  /** Frames of the search index by outcome: captioned, copied from another source, failed (docs/design/search.md). */
  readonly searchFrames = this.add(
    new Counter(
      'rideo_search_frames_total',
      'Frames of the search index by outcome (captioned, copied, failed)',
    ),
  );
  /** Searches by how they ranked (docs/design/search.md#searching). */
  readonly searches = this.add(
    new Counter('rideo_searches_total', 'Media searches by mode (semantic, words)'),
  );
  /** Brand kits created, applied and files added (docs/design/brand-kits.md). */
  readonly brand = this.add(
    new Counter('rideo_brand_total', 'Brand kits created, applied, removed and files added'),
  );
  /** Recipe steps run (docs/design/agents.md#recipes). */
  readonly recipeSteps = this.add(
    new Counter('rideo_recipe_steps_total', 'Recipe steps run by tool and outcome'),
  );
  /** Performance takes by outcome (docs/design/performance.md). */
  readonly performanceTakes = this.add(
    new Counter('rideo_performance_takes_total', 'Performance takes by outcome (passed, failed, error)'),
  );
  /** Mattes of Remove the background (docs/design/editor.md#segmentation-masks-remove-the-background). */
  readonly masks = this.add(new Counter('rideo_masks_total', 'Segmentation mattes by outcome'));
  /** NLE interchange (docs/design/interchange.md): cuts handed off and taken back. */
  readonly interchange = this.add(
    new Counter('rideo_interchange_total', 'Interchange files exported and imported by format and direction'),
  );
  /** Review (docs/design/review.md): comments, replies, decisions and share-link opens. */
  readonly review = this.add(
    new Counter('rideo_review_total', 'Review comments, decisions and link opens by event'),
  );
  readonly editorJobs = this.add(
    new Counter(
      'rideo_editor_jobs_total',
      'Editor-job lifecycle events (claimed, completed, failed, expired, released)',
    ),
  );
  readonly editorStagedBytes = this.add(
    new Counter('rideo_editor_staged_bytes_total', 'Bytes staged by editor jobs'),
  );
  readonly commits = this.add(new Counter('rideo_commits_total', 'Commits by actor kind'));
  readonly c2pa = this.add(
    new Counter('rideo_c2pa_operations_total', 'C2PA Content Credentials signs and reads by result'),
  );
  /** Dialogue (docs/design/dialogue.md): TTS calls by provider, operation and outcome; spoken characters. */
  readonly tts = this.add(
    new Counter('rideo_tts_requests_total', 'TTS requests by provider, op and outcome'),
  );
  readonly ttsCharacters = this.add(
    new Counter('rideo_tts_characters_total', 'Characters of text spoken by TTS, by provider'),
  );
  readonly lipSync = this.add(new Counter('rideo_lipsync_passes_total', 'Lip-sync passes by outcome'));
  readonly storyboardFrames = this.add(
    new Counter('rideo_storyboard_frames_total', 'Storyboard frames by consistency gate result'),
  );
  readonly voiceChecks = this.add(
    new Counter('rideo_voice_checks_total', 'Speaker checks of native-audio takes by result'),
  );
  /** Finishing (docs/design/finishing.md): enhanced parts, focus tracks and thumbnails. */
  readonly finishing = this.add(
    new Counter(
      'rideo_finishing_total',
      'Finishing operations (upscale, interpolate, focus, thumbnail) by outcome',
    ),
  );
  /** Localization (docs/design/localization.md): translated lines, dubbed takes and lip-sync passes. */
  readonly localization = this.add(
    new Counter('rideo_localization_total', 'Localization operations (translate, dub, lipsync) by outcome'),
  );
  /** Post audio (docs/design/post-audio.md): score cues, sound effects and loudness passes by outcome. */
  readonly postAudio = this.add(
    new Counter('rideo_post_audio_total', 'Post-audio operations (score_cue, sfx, loudness) by outcome'),
  );

  add<M extends Metric>(m: M): M {
    this.all.push(m);
    return m;
  }

  render(): string {
    return `${this.all
      .flatMap((m) => [`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`, ...m.render()])
      .join('\n')}\n`;
  }
}
