import { FileUp, Share2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button, buttonClass, Card, Field, Input, Select } from '../../components/ui';
import { api, interchangeUrl } from '../../lib/api';
import { useProjectRole } from '../../lib/auth';
import { useConfig } from '../../lib/config';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

const BASE_KEY = 'rideo.interchange.mediaBase';
const read = () => {
  try {
    return localStorage.getItem(BASE_KEY) ?? '';
  } catch {
    return '';
  }
};
const save = (v: string) => {
  try {
    if (v.trim()) localStorage.setItem(BASE_KEY, v.trim());
    else localStorage.removeItem(BASE_KEY);
  } catch {
    // private windows: remembered for this visit only
  }
};

const FORMATS = [
  { id: 'otio', label: 'OpenTimelineIO', hint: 'Resolve, pipelines' },
  { id: 'fcpxml', label: 'FCPXML', hint: 'Final Cut Pro' },
  { id: 'xml', label: 'XML', hint: 'Premiere Pro, Resolve' },
  { id: 'edl', label: 'EDL', hint: 'Avid, conform' },
] as const;

/**
 * Hands the cut to an NLE with its clips on WebDAV, and takes a re-edited cut back from OTIO
 * (docs/design/interchange.md#surfaces).
 */
export function InterchangeCard() {
  const { docs, projectId } = useProject();
  const cfg = useConfig();
  const { can } = useProjectRole(docs?.project);
  const [mediaBase, setMediaBase] = useState(read);
  const [source, setSource] = useState<'timeline' | 'animatic'>('timeline');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    clips: number;
    unresolved: { name: string }[];
    skipped: string[];
  } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  if (!docs || !projectId) return null;
  const hasCut = !!docs.timeline?.tracks.some((t) => t.items.length > 0);
  const hasAnimatic = !!docs.animatic?.tracks.some((t) => t.items.length > 0);
  const ready = source === 'animatic' ? hasAnimatic : hasCut;
  const importFile = async (f: File) => {
    setBusy(true);
    try {
      const r = await api.importOtio(projectId, f);
      setResult(r);
      useUi
        .getState()
        .toast(
          `Imported ${r.clips} clip${r.clips === 1 ? '' : 's'}${r.unresolved.length ? `; ${r.unresolved.length} not found` : ''}`,
          r.unresolved.length ? 'warning' : 'success',
        );
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <Card className="space-y-3 p-4" data-testid="interchange-card">
      <div className="flex items-center gap-2 font-medium">
        <Share2 className="size-4 text-muted" /> Hand off to an NLE
      </div>
      <p className="text-[13px] text-muted">
        The cut with its clips pointing at the originals on WebDAV. For Final Cut Pro and Premiere, mount the
        share and give its folder (Finder: <code>/Volumes/dav/rideo</code>).
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <Field
          label="Media location"
          hint={cfg?.features.interchange ? `Default: ${cfg.features.interchange.mediaBase}` : undefined}
        >
          <Input
            value={mediaBase}
            onChange={(e) => {
              setMediaBase(e.target.value);
              save(e.target.value);
            }}
            placeholder={cfg?.features.interchange?.mediaBase ?? 'file:///Volumes/dav/rideo'}
            data-testid="interchange-media-base"
          />
        </Field>
        <Field label="What">
          <Select
            value={source}
            onChange={(e) => setSource(e.target.value as 'timeline' | 'animatic')}
            data-testid="interchange-source"
          >
            <option value="timeline">The cut</option>
            {hasAnimatic ? <option value="animatic">The animatic</option> : null}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {FORMATS.map((f) =>
          ready ? (
            <a
              key={f.id}
              href={interchangeUrl(projectId, f.id, { mediaBase, source })}
              download
              className={buttonClass('secondary', 'sm')}
              title={f.hint}
              data-testid={`interchange-${f.id}`}
            >
              {f.label}
            </a>
          ) : (
            <Button
              key={f.id}
              size="sm"
              disabled
              title="Assemble the cut first"
              data-testid={`interchange-${f.id}`}
            >
              {f.label}
            </Button>
          ),
        )}
      </div>
      {can('project.edit') ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <input
            ref={file}
            type="file"
            accept=".otio,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
            }}
            data-testid="interchange-import-file"
          />
          <Button
            size="sm"
            icon={<FileUp className="size-3.5" />}
            loading={busy}
            onClick={() => file.current?.click()}
            data-testid="interchange-import"
          >
            Import OTIO…
          </Button>
          <span className="text-[12px] text-muted">Replaces the cut; History restores the previous one.</span>
        </div>
      ) : null}
      {result ? (
        <div className="space-y-1 text-[12px]" data-testid="interchange-import-result">
          <p>
            {result.clips} clip{result.clips === 1 ? '' : 's'} placed.
          </p>
          {result.unresolved.length ? (
            <p className="text-warning">
              Not media of this project: {result.unresolved.map((u) => u.name).join(', ')}
            </p>
          ) : null}
          {result.skipped.map((s) => (
            <p key={s} className="text-muted">
              {s}
            </p>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
