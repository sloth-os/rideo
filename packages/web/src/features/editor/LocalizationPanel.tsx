import {
  cutLines,
  isTerminalJob,
  LANGUAGES,
  languageName,
  localizationState,
  type TextItem,
  type Timeline,
  type TimelineOp,
} from '@rideo/shared';
import { Captions, Download, Languages, Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import { JobRow } from '../../components/JobProgress';
import { Badge, Button, Card, Dialog, Field, Input, Select } from '../../components/ui';
import { api, subtitlesUrl } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

type Animate = NonNullable<TextItem['style']['animate']>;
const STYLES: { value: Animate; label: string }[] = [
  { value: 'none', label: 'Whole lines' },
  { value: 'build', label: 'Word by word' },
  { value: 'pop', label: 'One word at a time' },
];

function SubtitleLinks({ projectId, language }: { projectId: string; language?: string }) {
  return (
    <span className="inline-flex gap-1">
      {(['srt', 'vtt'] as const).map((f) => (
        <a
          key={f}
          href={subtitlesUrl(projectId, f, language)}
          download
          className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-control)] border border-border px-2 text-[12px]"
          data-testid={`download-${f}`}
        >
          <Download className="size-3" /> {f.toUpperCase()}
        </a>
      ))}
    </span>
  );
}

/**
 * Captions & languages (docs/design/localization.md#surfaces): the caption style, subtitles, translations, dubs and
 * lip-synced close-ups of every language of the cut.
 */
export function LocalizationPanel({
  timeline,
  apply,
}: {
  timeline: Timeline;
  apply: (ops: TimelineOp[]) => void;
}) {
  const { projectId, docs } = useProject();
  const allJobs = useProject((s) => s.jobs);
  const [adding, setAdding] = useState('');
  const [dub, setDub] = useState(true);
  const [lipSync, setLipSync] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const jobs = useMemo(
    () => Object.values(allJobs).filter((j) => j.kind === 'localize.generate' && !isTerminalJob(j)),
    [allJobs],
  );
  if (!projectId || !docs) return null;
  const captions = timeline.tracks
    .filter((t) => t.kind === 'text')
    .flatMap((t) => t.items as TextItem[])
    .filter((i) => i.style.preset === 'caption');
  const animate = captions[0]?.style.animate ?? 'none';
  const languages = Object.values(docs.localizations).sort((a, b) => a.name.localeCompare(b.name));
  const speaks = cutLines(timeline, docs.clips).length > 0;
  const run = async (language: string, opts: { dub: boolean; lipSync: boolean }) => {
    try {
      await api.localize(projectId, { language, ...opts });
      useUi
        .getState()
        .toast(`${opts.dub ? 'Dubbing' : 'Translating'} into ${languageName(language)}…`, 'info');
    } catch (err) {
      reportError(err);
    }
  };
  const available = Object.entries(LANGUAGES).filter(([code]) => !docs.localizations[code]);
  return (
    <Card className="space-y-3 p-3" data-testid="localization-panel">
      <p className="flex items-center gap-1.5 text-[13px] font-medium">
        <Captions className="size-4" /> Captions &amp; languages
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Caption style">
          <Select
            value={animate}
            disabled={!captions.length}
            onChange={(e) =>
              apply([{ op: 'set_caption_style', style: { animate: e.target.value as Animate } }])
            }
            data-testid="caption-style"
          >
            {STYLES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        {captions.length ? <SubtitleLinks projectId={projectId} /> : null}
      </div>
      <ul className="space-y-2" data-testid="languages">
        {languages.map((loc) => {
          const state = localizationState(loc, timeline, docs.clips, docs.characters);
          const busy = jobs.some((j) => j.params.language === loc.id);
          return (
            <li
              key={loc.id}
              className="space-y-1.5 rounded-[var(--radius-control)] border border-border p-2"
              data-language={loc.id}
            >
              <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                <span className="font-medium">{loc.name}</span>
                <Badge
                  tone={state.lines.current === state.lines.total ? 'success' : 'warning'}
                  testid="language-lines"
                >
                  lines {state.lines.current}/{state.lines.total}
                </Badge>
                {state.dubs.needed ? (
                  <Badge
                    tone={state.dubs.current === state.dubs.needed ? 'success' : 'neutral'}
                    testid="language-dubs"
                  >
                    dubbed {state.dubs.current}/{state.dubs.needed}
                  </Badge>
                ) : null}
                {state.dubs.lipSynced ? (
                  <Badge testid="language-lipsync">lip-synced {state.dubs.lipSynced}</Badge>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => run(loc.id, { dub: false, lipSync: false })}
                  data-testid="translate-language"
                >
                  Translate
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => run(loc.id, { dub: true, lipSync })}
                  data-testid="dub-language"
                >
                  Dub
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Pencil className="size-3" />}
                  onClick={() => setEditing(loc.id)}
                  data-testid="edit-translations"
                >
                  Edit
                </Button>
                {state.lines.current === state.lines.total && state.lines.total ? (
                  <SubtitleLinks projectId={projectId} language={loc.id} />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Add a language">
            <Select
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              data-testid="add-language-select"
            >
              <option value="">Choose…</option>
              {available.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            size="sm"
            icon={<Languages className="size-3.5" />}
            disabled={!adding || !speaks}
            title={speaks ? undefined : 'The cut has no dialogue'}
            onClick={async () => {
              await run(adding, { dub, lipSync: dub && lipSync });
              setAdding('');
            }}
            data-testid="add-language"
          >
            {dub ? 'Translate and dub' : 'Translate'}
          </Button>
        </div>
        <div className="flex flex-wrap gap-3 text-[12px]">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={dub}
              onChange={(e) => setDub(e.target.checked)}
              className="size-4 accent-[var(--color-accent)]"
              data-testid="add-language-dub"
            />
            Dub with the characters’ voices
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={lipSync}
              disabled={!dub}
              onChange={(e) => setLipSync(e.target.checked)}
              className="size-4 accent-[var(--color-accent)]"
              data-testid="add-language-lipsync"
            />
            Lip-sync close-ups
          </label>
        </div>
      </div>
      {jobs.map((j) => (
        <JobRow key={j.id} job={j} projectId={projectId} />
      ))}
      {editing ? (
        <TranslationsDialog
          projectId={projectId}
          language={editing}
          timeline={timeline}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Card>
  );
}

function TranslationsDialog({
  projectId,
  language,
  timeline,
  onClose,
}: {
  projectId: string;
  language: string;
  timeline: Timeline;
  onClose: () => void;
}) {
  const docs = useProject((s) => s.docs);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (!docs) return null;
  const loc = docs.localizations[language];
  const lines = cutLines(timeline, docs.clips);
  const save = async (shotId: string, index: number) => {
    const key = `${shotId}:${index}`;
    const text = drafts[key]?.trim();
    if (!text) return;
    try {
      await api.updateTranslation(projectId, language, { shotId, index, text });
      setDrafts((d) => {
        const { [key]: _, ...rest } = d;
        return rest;
      });
    } catch (err) {
      reportError(err);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`${languageName(language)} translation`}>
      <ul className="max-h-[60vh] space-y-3 overflow-y-auto" data-testid="translations">
        {lines.map((l) => {
          const key = `${l.shotId}:${l.index}`;
          const tr = loc?.lines.find((x) => x.shotId === l.shotId && x.index === l.index);
          const stale = tr && tr.source !== l.text;
          return (
            <li key={key} className="space-y-1" data-line={key}>
              <p className="text-[12px] text-muted">
                {l.characterId ? `${docs.characters[l.characterId]?.name ?? ''}: ` : ''}
                {l.text}
                {stale ? <span className="ml-1 text-warning">(changed since translated)</span> : null}
              </p>
              <div className="flex gap-2">
                <Input
                  value={drafts[key] ?? tr?.text ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                  aria-label={`Translation of line ${l.index + 1}`}
                  data-testid="translation-input"
                />
                <Button
                  size="sm"
                  disabled={drafts[key] === undefined}
                  onClick={() => save(l.shotId, l.index)}
                  data-testid="translation-save"
                >
                  Save
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
