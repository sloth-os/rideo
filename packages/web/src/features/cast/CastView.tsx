import {
  approvedReferences,
  type Character,
  type Identity,
  isRealPersonCharacter,
  isTerminalJob,
  type ReferenceView,
} from '@rideo/shared';
import { Check, ImagePlus, Lock, Sparkles, Trash2, Unlock, UserCheck, UserPlus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { ConsentDialog } from '../../components/ConsentDialog';
import { Editable } from '../../components/Editable';
import { Entity } from '../../components/Entity';
import { JobRow } from '../../components/JobProgress';
import { MediaImage } from '../../components/Media';
import {
  Badge,
  Button,
  cx,
  Dialog,
  EmptyState,
  Field,
  Input,
  SectionHeader,
  Select,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

const IDENTITY_FIELDS: [keyof Identity, string][] = [
  ['age', 'Age'],
  ['gender', 'Gender'],
  ['ethnicity', 'Ethnicity'],
  ['build', 'Build'],
  ['height', 'Height'],
  ['face', 'Face'],
  ['hair', 'Hair'],
  ['eyes', 'Eyes'],
  ['skin', 'Skin'],
  ['distinguishingMarks', 'Distinguishing marks'],
];

const VIEWS: ReferenceView[] = ['front', 'three_quarter', 'profile', 'full_body', 'expression', 'custom'];

function CharacterCard({ c }: { c: Character }) {
  const { projectId, jobs } = useProject();
  const [view, setView] = useState<ReferenceView>('front');
  const [pending, setPending] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!projectId) return null;
  const locked = c.lock.locked;
  const job = Object.values(jobs).find(
    (j) =>
      !isTerminalJob(j) &&
      (j.kind === 'character.refs' || j.kind === 'character.describe') &&
      j.params.characterId === c.id,
  );
  const update = (body: Record<string, unknown>) =>
    api.updateCharacter(projectId, c.id, body, `character:${c.id}`);
  const approved = approvedReferences(c).length;
  return (
    <Entity
      kind="character"
      id={c.id}
      as="article"
      className="rounded-[var(--radius-card)] border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold" data-testid="character-name">
              {c.name}
            </h3>
            <Badge>{c.role}</Badge>
            {locked ? (
              <Badge tone="success" title={`Locked ${c.lock.lockedAt ?? ''}`}>
                <Lock className="size-3" /> locked v{c.lock.version}
              </Badge>
            ) : (
              <Badge tone="warning">unlocked</Badge>
            )}
            {isRealPersonCharacter(c) ? (
              <Badge
                tone="info"
                title="A real person with recorded consent: exports carry the disclosure label"
              >
                <UserCheck className="size-3" /> real person
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-[12px] text-muted">{c.summary}</p>
        </div>
        {locked ? (
          <Button
            size="sm"
            icon={<Unlock className="size-3.5" />}
            onClick={() => api.unlock(projectId, c.id).catch(reportError)}
            data-testid="unlock-character"
          >
            Unlock
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon={<Lock className="size-3.5" />}
            disabled={approved === 0}
            title={approved === 0 ? 'Approve a reference first' : 'Lock identity'}
            onClick={() => api.lock(projectId, c.id).catch(reportError)}
            data-testid="lock-character"
          >
            Lock
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h4 className="flex-1 text-[11px] font-medium tracking-wide text-muted uppercase">
              References ({approved} approved)
            </h4>
            <Button
              size="sm"
              icon={<Sparkles className="size-3.5" />}
              disabled={locked || !!job}
              onClick={() => api.generateRefs(projectId, c.id).catch(reportError)}
              data-testid="generate-refs"
            >
              Generate
            </Button>
          </div>
          {job ? <JobRow job={job} projectId={projectId} compact /> : null}
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {c.references.map((r) => (
              <div
                key={r.id}
                className={cx(
                  'group relative overflow-hidden rounded-[var(--radius-control)] border-2',
                  r.approved ? 'border-success' : 'border-border',
                )}
                data-testid="reference"
              >
                <MediaImage
                  projectId={projectId}
                  media={r.media}
                  alt={`${c.name} ${r.view}`}
                  className="aspect-square w-full"
                />
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                  <span>{r.view.replace('_', ' ')}</span>
                  <span className="flex items-center gap-1">
                    {r.consent?.depictsRealPerson ? (
                      <span
                        title={`Real person: ${r.consent.subject}, consent by ${r.consent.grantedBy} on ${r.consent.grantedAt}`}
                      >
                        <UserCheck className="size-3" aria-label="Real person with consent" />
                      </span>
                    ) : null}
                    {r.approved ? <Check className="size-3 text-success" /> : null}
                  </span>
                </div>
                {!locked ? (
                  <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      size="sm"
                      variant={r.approved ? 'secondary' : 'primary'}
                      className="h-7"
                      onClick={() =>
                        api.approveReference(projectId, c.id, r.id, !r.approved).catch(reportError)
                      }
                      data-testid="approve-reference"
                      aria-label={r.approved ? 'Unapprove reference' : 'Approve reference'}
                    >
                      {r.approved ? <X className="size-3.5" /> : <Check className="size-3.5" />}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      className="h-7"
                      onClick={() => api.deleteReference(projectId, c.id, r.id).catch(reportError)}
                      aria-label="Remove reference"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
            {!locked ? (
              <div className="flex aspect-square flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] border border-dashed border-border p-1">
                <Select
                  value={view}
                  onChange={(e) => setView(e.target.value as ReferenceView)}
                  className="h-7 px-1 text-[11px]"
                  aria-label="Reference view"
                >
                  {VIEWS.map((v) => (
                    <option key={v} value={v}>
                      {v.replace('_', ' ')}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  icon={<ImagePlus className="size-3.5" />}
                  onClick={() => fileRef.current?.click()}
                >
                  Upload
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  data-testid="upload-reference"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setPending(f);
                    e.target.value = '';
                  }}
                />
              </div>
            ) : null}
          </div>
          <ConsentDialog
            open={!!pending}
            what="reference image"
            fileName={pending?.name}
            onCancel={() => setPending(null)}
            onConfirm={async (consent) => {
              if (!pending) return;
              try {
                await api.uploadReference(projectId, c.id, pending, view, consent);
                setPending(null);
              } catch (err) {
                reportError(err);
              }
            }}
          />
          {c.references.length > 0 && !locked && approved < c.references.length ? (
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              icon={<Check className="size-3.5" />}
              onClick={async () => {
                try {
                  for (const r of c.references.filter((x) => !x.approved))
                    await api.approveReference(projectId, c.id, r.id, true);
                } catch (err) {
                  reportError(err);
                }
              }}
              data-testid="approve-all-references"
            >
              Approve all
            </Button>
          ) : null}
        </div>
        <div>
          <h4 className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">
            Identity {locked ? '(frozen while locked)' : ''}
          </h4>
          <div className="grid grid-cols-2 gap-2">
            {IDENTITY_FIELDS.map(([k, label]) => (
              <Field
                key={k}
                label={label}
                className={k === 'face' || k === 'hair' || k === 'distinguishingMarks' ? 'col-span-2' : ''}
              >
                {locked ? (
                  <div className="min-h-9 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 py-2 text-[13px] text-muted">
                    {c.identity[k] || '—'}
                  </div>
                ) : (
                  <Editable
                    value={c.identity[k] ?? ''}
                    onSave={(v) => update({ identity: { [k]: v } })}
                    ariaLabel={`${c.name} ${label}`}
                  />
                )}
              </Field>
            ))}
          </div>
          <h4 className="mt-3 mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">Wardrobe</h4>
          {c.wardrobe.map((w, i) => (
            <div key={w.id} className="mb-2 text-[13px]">
              {locked ? (
                <p>
                  <span className="font-medium">{w.name}</span>
                  {w.default ? <Badge className="ml-1">default</Badge> : null}:{' '}
                  <span className="text-muted">{w.description}</span>
                </p>
              ) : (
                <Editable
                  value={w.description}
                  onSave={(v) =>
                    update({ wardrobe: c.wardrobe.map((x, j) => (j === i ? { ...x, description: v } : x)) })
                  }
                  ariaLabel={`Wardrobe ${w.name}`}
                />
              )}
            </div>
          ))}
          {!locked ? (
            <Field label="Summary" className="mt-2">
              <Editable value={c.summary} multiline rows={2} onSave={(v) => update({ summary: v })} />
            </Field>
          ) : null}
        </div>
      </div>
    </Entity>
  );
}

export function CastView() {
  const { docs, projectId, workflow } = useProject();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  if (!docs || !projectId) return null;
  const characters = Object.values(docs.characters).sort(
    (a, b) =>
      (a.role === 'protagonist' ? -1 : 0) - (b.role === 'protagonist' ? -1 : 0) ||
      a.name.localeCompare(b.name),
  );
  const gate = workflow?.stages.find((s) => s.id === 'cast')?.gate;
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <SectionHeader
        title="Cast"
        subtitle="Approve references and lock each character. Only locked identities can appear in generated shots."
        actions={
          <>
            <Button
              icon={<UserPlus className="size-4" />}
              onClick={() => setAdding(true)}
              data-testid="add-character"
            >
              Add character
            </Button>
            {workflow?.stage === 'cast' && gate ? (
              <Button
                variant="primary"
                icon={<Lock className="size-4" />}
                disabled={!gate.satisfied}
                onClick={() =>
                  api
                    .approve(projectId, 'cast_locked')
                    .then(() => useUi.getState().toast('Cast locked', 'success'))
                    .catch(reportError)
                }
                data-testid="approve-cast"
              >
                Lock cast
              </Button>
            ) : null}
          </>
        }
      />
      {characters.length === 0 ? (
        <EmptyState title="No characters yet">
          Generate the screenplay to draft a cast, or add characters yourself.
        </EmptyState>
      ) : (
        <div className="space-y-4" data-testid="characters">
          {characters.map((c) => (
            <CharacterCard key={c.id} c={c} />
          ))}
        </div>
      )}
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add character"
        footer={
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={() =>
              api
                .createCharacter(projectId, { name })
                .then(() => {
                  setAdding(false);
                  setName('');
                })
                .catch(reportError)
            }
            data-testid="add-character-submit"
          >
            Add
          </Button>
        }
      >
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Mira"
            data-testid="new-character-name"
          />
        </Field>
      </Dialog>
    </div>
  );
}
