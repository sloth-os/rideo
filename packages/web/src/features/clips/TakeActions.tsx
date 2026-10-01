import type { Clip, EditKind, Shot, Take } from '@rideo/shared';
import { Expand, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Dialog, Field, Input, Select, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { reportError, useUi } from '../../store/ui';

const KINDS: { kind: EditKind; label: string; placeholder: string }[] = [
  { kind: 'restyle', label: 'Restyle', placeholder: 'hand-painted watercolour, muted palette' },
  { kind: 'relight', label: 'Relight', placeholder: 'warm golden-hour light from the window' },
  { kind: 'replace', label: 'Replace', placeholder: 'the red umbrella with a black one' },
  { kind: 'angle', label: 'New angle', placeholder: 'from behind, over her shoulder' },
  { kind: 'remove', label: 'Remove', placeholder: 'the lamp post on the left' },
];

/** The lineage of a derived take (docs/design/take-editing.md#derived-takes). */
export function LineageBadge({ take }: { take: Take }) {
  const d = take.derivedFrom;
  if (!d) return null;
  return (
    <Badge tone="info" title={d.instruction ?? undefined} testid="take-lineage">
      {d.op === 'edit' ? `edited · ${d.kind}` : `extended +${d.seconds}s`}
    </Badge>
  );
}

/** A take cut from a multi-shot render (docs/design/multi-shot.md#splitting-and-verification). */
export function MultiShotBadge({ take }: { take: Take }) {
  const m = take.request.multiShot;
  if (!m) return null;
  return (
    <Badge
      title={`Rendered with the group's other shots in one request; split at the ${m.cut === 'detected' ? 'detected cut' : 'planned length'}`}
      testid="take-multishot"
    >
      shot {m.index + 1} of {m.of}
    </Badge>
  );
}

/** Edit (video-to-video) and Extend (+N s) a take (docs/design/take-editing.md). */
export function TakeActions({
  projectId,
  clip,
  shot,
  take,
}: {
  projectId: string;
  clip: Clip;
  shot: Shot;
  take: Take;
}) {
  const [open, setOpen] = useState<'edit' | 'extend' | null>(null);
  const [kind, setKind] = useState<EditKind>('relight');
  const [instruction, setInstruction] = useState('');
  const [seconds, setSeconds] = useState(3);
  const [prompt, setPrompt] = useState('');
  if (!take.video) return null;
  const done = (what: string) => {
    useUi.getState().toast(`${what}: the new take appears when it is verified`, 'info');
    setOpen(null);
  };
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        icon={<Wand2 className="size-3.5" />}
        onClick={() => setOpen('edit')}
        data-testid="edit-take"
      >
        Edit
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        icon={<Expand className="size-3.5" />}
        onClick={() => setOpen('extend')}
        data-testid="extend-take"
      >
        Extend
      </Button>
      <Dialog
        open={open === 'edit'}
        onClose={() => setOpen(null)}
        title="Edit this take"
        footer={
          <Button
            variant="primary"
            disabled={instruction.trim().length < 2}
            onClick={() =>
              api
                .editTake(projectId, clip.id, shot.id, take.id, { kind, instruction: instruction.trim() })
                .then(() => done('Editing'))
                .catch(reportError)
            }
            data-testid="edit-submit"
          >
            Edit
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Change">
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as EditKind)}
              data-testid="edit-kind"
            >
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Instruction">
            <Textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder={KINDS.find((k) => k.kind === kind)!.placeholder}
              data-testid="edit-instruction"
            />
          </Field>
          <p className="text-[12px] text-muted">
            The faces, the action and the camera move are kept; the result is checked against the cast like
            any take and keeps this take's sound.
          </p>
        </div>
      </Dialog>
      <Dialog
        open={open === 'extend'}
        onClose={() => setOpen(null)}
        title="Extend this take"
        footer={
          <Button
            variant="primary"
            onClick={() =>
              api
                .extendTake(projectId, clip.id, shot.id, take.id, {
                  seconds,
                  ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
                })
                .then(() => done('Extending'))
                .catch(reportError)
            }
            data-testid="extend-submit"
          >
            Extend +{seconds} s
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Seconds">
            <Select
              value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value))}
              data-testid="extend-take-seconds"
            >
              {[1, 2, 3, 4, 5, 6, 8, 10].map((s) => (
                <option key={s} value={s}>
                  +{s} s
                </option>
              ))}
            </Select>
          </Field>
          <Field label="What happens next (optional)">
            <Input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={1000}
              placeholder="she turns to the window"
              data-testid="extend-take-prompt"
            />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
