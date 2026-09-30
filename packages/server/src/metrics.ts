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
