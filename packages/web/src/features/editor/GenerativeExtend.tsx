import { isStillMedia, isTerminalJob, type VideoItem } from '@rideo/shared';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { JobRow } from '../../components/JobProgress';
import { Button, Field, Input, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

/**
 * Generative extend (docs/design/take-editing.md#generative-extend-in-the-editor): frames generated from the item's
 * first or last frame, inserted before or after it.
 */
export function GenerativeExtend({ item }: { item: VideoItem }) {
  const projectId = useProject((s) => s.projectId);
  const job = useProject((s) =>
    Object.values(s.jobs).find(
      (j) => j.kind === 'timeline.extend' && j.params.itemId === item.id && !isTerminalJob(j),
    ),
  );
  const [edge, setEdge] = useState<'start' | 'end'>('end');
  const [seconds, setSeconds] = useState(2);
  const [prompt, setPrompt] = useState('');
  if (!projectId || isStillMedia(item.source.media)) return null;
  return (
    <div
      className="space-y-2 rounded-[var(--radius-control)] border border-border p-2.5"
      data-testid="generative-extend"
    >
      <p className="flex items-center gap-1.5 text-[12px] font-medium">
        <Sparkles className="size-3.5" /> Generative extend
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Where">
          <Select
            value={edge}
            onChange={(e) => setEdge(e.target.value as 'start' | 'end')}
            data-testid="extend-edge"
          >
            <option value="end">After the end</option>
            <option value="start">Before the start</option>
          </Select>
        </Field>
        <Field label="Seconds">
          <Select
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value))}
            data-testid="extend-seconds"
          >
            {[1, 1.5, 2, 3, 4, 5].map((s) => (
              <option key={s} value={s}>
                +{s} s
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Input
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="What happens (optional)"
        maxLength={1000}
        aria-label="What happens in the extension"
      />
      {job ? (
        <JobRow job={job} projectId={projectId} compact />
      ) : (
        <Button
          size="sm"
          icon={<Sparkles className="size-3.5" />}
          onClick={() =>
            api
              .extendItem(projectId, item.id, {
                edge,
                seconds,
                ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
              })
              .then(() =>
                useUi
                  .getState()
                  .toast(`Generating ${seconds} s ${edge === 'end' ? 'after' : 'before'} the item`, 'info'),
              )
              .catch(reportError)
          }
          data-testid="extend-item"
        >
          Generate +{seconds} s
        </Button>
      )}
    </div>
  );
}
