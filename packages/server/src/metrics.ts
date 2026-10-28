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
  add(labels: Labels, delta: number): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + delta);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
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
  /** From queued to the first start (docs/design/observability.md#metrics). */
  readonly jobWait = this.add(
    new Histogram('rideo_job_wait_seconds', 'Time from queued to the first start, by kind'),
  );
  readonly laneJobs = this.add(
    new Gauge('rideo_lane_jobs', 'Jobs per lane now, by state (running, waiting)'),
  );
  readonly gatewayTaskSeconds = this.add(
    new Histogram(
      'rideo_gateway_task_seconds',
      'mm-gateway tasks from create to terminal, by modality and model',
    ),
  );
  readonly gatewayUsage = this.add(
    new Counter('rideo_gateway_usage_total', 'Generated output by modality, model and unit'),
  );
  readonly llmCallSeconds = this.add(
    new Histogram(
      'rideo_llm_call_seconds',
      'Structured LLM tasks (repairs and retries included), by task and model',
      [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
    ),
  );
  readonly llmTokens = this.add(
    new Counter('rideo_llm_tokens_total', 'Tokens reported by the provider, by task, model and direction'),
  );
  readonly costUsd = this.add(
    new Counter('rideo_cost_usd_total', 'Estimated cost of priced usage in USD, by modality and model'),
  );
  readonly usageUnpriced = this.add(
    new Counter('rideo_usage_unpriced_total', 'Usage items of models without a price, by modality and model'),
  );
  readonly shotStepSeconds = this.add(
    new Histogram(
      'rideo_shot_step_seconds',
      'Time of the shot pipeline steps',
      [0.5, 1, 5, 10, 30, 60, 120, 300, 600, 1200],
    ),
  );
  readonly takeAttempts = this.add(
    new Histogram(
      'rideo_take_attempts',
      'Attempts until a take passed (or ran out), by stage',
      [1, 2, 3, 4, 5, 6, 8],
    ),
  );
  readonly consistencyScore = this.add(
    new Histogram(
      'rideo_consistency_score',
      'Judge scores of video attempts',
      [0.1, 0.25, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1],
    ),
  );
  readonly qualityChecks = this.add(
    new Counter(
      'rideo_quality_checks_total',
      'Temporal and physics checks of video attempts, by check and result',
    ),
  );
  readonly feedback = this.add(new Counter('rideo_feedback_total', 'Feedback runs by outcome'));
  readonly feedbackScore = this.add(
    new Histogram(
      'rideo_feedback_score',
      'Film scores of feedback (0-10), by dimension',
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    ),
  );
  readonly feedbackRecommendations = this.add(
    new Counter(
      'rideo_feedback_recommendations_total',
      'Feedback recommendations applied or dismissed, by action and outcome',
    ),
  );
  /** AI review of the screenplay and the storyboard (docs/design/ai-review.md#observability). */
  readonly aiReviews = this.add(
    new Counter(
      'rideo_ai_reviews_total',
      'AI reviews of a stage, by stage and outcome (passed, failed, error)',
    ),
  );
  readonly aiReviewScore = this.add(
    new Histogram(
      'rideo_ai_review_score',
      'Overall scores of AI reviews (0-10), by stage',
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    ),
  );
  readonly aiReviewRounds = this.add(
    new Histogram(
      'rideo_ai_review_rounds',
      'Reviews a stage needed before it stopped, by stage',
      [1, 2, 3, 4],
    ),
  );
  readonly aiReviewRecommendations = this.add(
    new Counter(
      'rideo_ai_review_recommendations_total',
      'AI review recommendations applied (by a person or automatically) or dismissed, by stage, action and outcome',
    ),
  );
  /** Exports written to storage behind their readiness (docs/design/storage-webdav.md#local-cache-and-staging). */
  readonly mediaUploadsPending = this.add(
    new Gauge('rideo_media_uploads_pending', 'Files ready in the cache and waiting to be written to storage'),
  );
  readonly mediaUploads = this.add(
    new Counter(
      'rideo_media_uploads_total',
      'Background uploads of cached files to storage, by outcome (done, retried)',
    ),
  );
  readonly llmFallbacks = this.add(
    new Counter(
      'rideo_llm_fallbacks_total',
      'Language, vision and listening calls sent to their family’s fallback endpoint, by task',
    ),
  );
  readonly clipReviews = this.add(
    new Counter(
      'rideo_clip_reviews_total',
      'Scenes watched before the edit, by outcome (clean: nothing to fix, fixed: fixes applied, error)',
    ),
  );
  readonly clipReviewScore = this.add(
    new Histogram(
      'rideo_clip_review_score',
      'Overall scores of scenes watched before the edit (0-10), by round (1, or 2 after the fixes)',
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    ),
  );
  readonly clipReviewFixes = this.add(
    new Counter(
      'rideo_clip_review_fixes_total',
      'Shots a scene review generated again, by outcome (fixed, not_fixed, failed)',
    ),
  );
  readonly httpSeconds = this.add(
    new Histogram(
      'rideo_http_request_seconds',
      'REST latency by method, route pattern and status class',
      [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    ),
  );
  readonly storageOpsPerRequest = this.add(
    new Histogram(
      'rideo_storage_ops_per_request',
      'Storage operations one request made',
      [0, 1, 2, 5, 10, 20, 50, 100, 500],
    ),
  );
  readonly webVitals = this.add(
    new Histogram(
      'rideo_web_vitals_seconds',
      'Core Web Vitals of the studio, by metric',
      [0.05, 0.1, 0.2, 0.5, 1, 1.8, 2.5, 4, 8, 15],
    ),
  );
  readonly webCls = this.add(
    new Histogram('rideo_web_cls', 'Layout shift of the studio', [0.01, 0.05, 0.1, 0.25, 0.5, 1]),
  );
  readonly webTiming = this.add(
    new Histogram(
      'rideo_web_timing_seconds',
      'Studio operations people wait for, by op',
      [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
    ),
  );
  readonly webErrors = this.add(new Counter('rideo_web_errors_total', 'Errors in the studio, by kind'));
  readonly gatewayTasks = this.add(
    new Counter('rideo_gateway_tasks_total', 'mm-gateway tasks by modality and status'),
  );
  readonly llmCalls = this.add(new Counter('rideo_llm_calls_total', 'LLM task calls by task and status'));
  /** LLM calls made again after the provider turned them away for load (docs/design/ai-gateway.md#structured-tasks). */
  readonly llmRetries = this.add(
    new Counter('rideo_llm_retries_total', 'LLM calls made again after 429/5xx, by task and status'),
  );
  /** Model endpoints paused after failing calls in a row (docs/design/ai-gateway.md#outages). */
  readonly llmPaused = this.add(
    new Gauge(
      'rideo_llm_paused',
      'Whether a model endpoint is in an outage (1 from its first pause until it answers)',
    ),
  );
  readonly llmPauses = this.add(
    new Counter('rideo_llm_pauses_total', 'Times a model endpoint was paused, by endpoint'),
  );
  /** The project list and the Inbox (docs/design/storage-webdav.md#slow-and-flaky-servers). */
  readonly projectDigests = this.add(
    new Counter(
      'rideo_project_digests_total',
      'Project summaries the project list and the Inbox read, by source (file: at the tip; documents: made again)',
    ),
  );
  /** Maintenance of a long-running studio (docs/design/storage-webdav.md#maintenance). */
  readonly projectsWarmed = this.add(
    new Counter(
      'rideo_projects_warmed_total',
      'Projects whose documents and recent log were loaded in the background',
    ),
  );
  readonly projectsVanished = this.add(
    new Counter('rideo_projects_vanished_total', 'Loaded projects forgotten because their folder is gone'),
  );
  readonly trashPurged = this.add(
    new Counter('rideo_trash_purged_total', 'Deleted projects removed for good 7 days after their deletion'),
  );
  readonly consistency = this.add(new Counter('rideo_consistency_checks_total', 'Consistency gate outcomes'));
  readonly watermark = this.add(
    new Counter('rideo_watermark_operations_total', 'Watermark embeds and detections'),
  );
  readonly storageLatency = this.add(
    new Histogram(
      'rideo_storage_seconds',
      'WebDAV operation latency',
      [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
    ),
  );
  /** WebDAV requests tried again after a transient failure (docs/design/storage-webdav.md#slow-and-flaky-servers). */
  readonly storageRetries = this.add(
    new Counter('rideo_storage_retries_total', 'WebDAV requests tried again, by op and reason'),
  );
  /** Work-tree writes behind commits (docs/design/storage-webdav.md#external-edits), by outcome. */
  readonly worktreeBatches = this.add(
    new Counter('rideo_worktree_batches_total', 'Work-tree materialization batches by outcome'),
  );
  /** Documents waiting to be written to the work tree, across projects. */
  readonly worktreePending = this.add(
    new Gauge('rideo_worktree_pending_docs', 'Documents waiting for the work tree'),
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

  /** Settings changes applied by reloading the studio (docs/design/settings.md#applying-a-change), by result. */
  readonly settingsReloads = this.add(
    new Counter('rideo_settings_reloads_total', 'Studio reloads after a settings change, by result'),
  );
  /** API keys set in Settings registered in mm-gateway (docs/design/settings.md#registration-in-mm-gateway). */
  readonly gatewayProxySync = this.add(
    new Counter(
      'rideo_gateway_proxy_sync_total',
      'Syncs of the gateway proxies of API keys set in Settings, by result',
    ),
  );
  /** Browser storage (docs/design/browser-storage.md): operations sent to workspaces, by op and outcome. */
  readonly workspaceOps = this.add(
    new Counter(
      'rideo_workspace_storage_ops_total',
      'Storage operations served by browser workspaces, by op and outcome',
    ),
  );
  /** Browser storage: bytes moved between the server and workspaces, by direction. */
  readonly workspaceBytes = this.add(
    new Counter(
      'rideo_workspace_storage_bytes_total',
      'Bytes moved to (write) and from (read) browser workspaces',
    ),
  );
  /** Browser storage: workspaces with at least one attached tab. */
  readonly workspaces = this.add(
    new Gauge('rideo_workspaces_attached', 'Browser workspaces with an attached tab'),
  );
  /** Project files (docs/design/browser-storage.md#project-files-export-and-import), by direction and outcome. */
  readonly bundles = this.add(
    new Counter(
      'rideo_project_bundles_total',
      'Project files exported and imported, by direction and outcome',
    ),
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
