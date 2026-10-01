import {
  approvedElementReferences,
  ELEMENT_VIEWS,
  type Element,
  type ElementKind,
  type ElementReferenceView,
  elementsInUse,
  isTerminalJob,
} from '@rideo/shared';
import { Check, ImagePlus, Lock, Plus, Sparkles, Trash2, Unlock, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Editable } from '../../components/Editable';
import { ELEMENT_ICON } from '../../components/ElementPicker';
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
  Textarea,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError } from '../../store/ui';

const KINDS: { kind: ElementKind; title: string; hint: string }[] = [
  { kind: 'location', title: 'Locations', hint: 'Places that must look the same in every scene.' },
  { kind: 'prop', title: 'Props', hint: 'Objects that must not change between shots.' },
  { kind: 'style', title: 'Styles', hint: 'Looks to reproduce: a painting style, a film stock, a palette.' },
];

const ALL_VIEWS: ElementReferenceView[] = ['establishing', 'angle', 'detail', 'custom'];

function ElementCard({ e, inUse }: { e: Element; inUse: boolean }) {
  const { projectId, jobs } = useProject();
  const [view, setView] = useState<ElementReferenceView>(ELEMENT_VIEWS[e.kind][0]!);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!projectId) return null;
  const locked = e.lock.locked;
  const Icon = ELEMENT_ICON[e.kind];
  const approved = approvedElementReferences(e).length;
  const job = Object.values(jobs).find(
    (j) => !isTerminalJob(j) && j.kind === 'element.refs' && j.params.elementId === e.id,
  );
  return (
    <Entity
      kind="element"
      id={e.id}
      as="article"
      className="rounded-[var(--radius-card)] border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Icon className="size-4 text-muted" />
        <h3 className="min-w-0 flex-1 truncate text-base font-semibold" data-testid="element-name">
          {e.name}
        </h3>
        {inUse ? <Badge tone="accent">in use</Badge> : <Badge>unused</Badge>}
        {locked ? (
          <Badge tone="success" title={`Locked ${e.lock.lockedAt ?? ''}`}>
            <Lock className="size-3" /> locked v{e.lock.version}
          </Badge>
        ) : (
          <Badge tone="warning">unlocked</Badge>
        )}
        {locked ? (
          <Button
            size="sm"
            icon={<Unlock className="size-3.5" />}
            onClick={() => api.unlockElement(projectId, e.id).catch(reportError)}
            data-testid="unlock-element"
          >
            Unlock
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon={<Lock className="size-3.5" />}
            disabled={approved === 0}
            title={approved === 0 ? 'Approve a reference first' : 'Lock'}
            onClick={() => api.lockElement(projectId, e.id).catch(reportError)}
            data-testid="lock-element"
          >
            Lock
          </Button>
        )}
        {!locked && !inUse ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${e.name}`}
            icon={<Trash2 className="size-3.5" />}
            onClick={() =>
              confirm(`Remove ${e.name}?`) && api.deleteElement(projectId, e.id).catch(reportError)
            }
          />
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h4 className="flex-1 text-[11px] font-medium tracking-wide text-muted uppercase">
              References ({approved} approved)
            </h4>
            <Button
              size="sm"
              icon={<Sparkles className="size-3.5" />}
              disabled={locked || !!job}
              onClick={() => api.generateElementRefs(projectId, e.id).catch(reportError)}
              data-testid="generate-element-refs"
            >
              Generate
            </Button>
          </div>
          {job ? <JobRow job={job} projectId={projectId} compact /> : null}
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {e.references.map((r) => (
              <div
                key={r.id}
                className={cx(
                  'group relative overflow-hidden rounded-[var(--radius-control)] border-2',
                  r.approved ? 'border-success' : 'border-border',
                )}
                data-testid="element-reference"
              >
                <MediaImage
                  projectId={projectId}
                  media={r.media}
                  alt={`${e.name} ${r.view}`}
                  className="aspect-square w-full"
                />
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                  <span>{r.view}</span>
                  {r.approved ? <Check className="size-3 text-success" /> : null}
                </div>
                {!locked ? (
                  <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      size="sm"
                      variant={r.approved ? 'secondary' : 'primary'}
                      className="h-7"
                      onClick={() =>
                        api.approveElementReference(projectId, e.id, r.id, !r.approved).catch(reportError)
                      }
                      aria-label={r.approved ? 'Unapprove reference' : 'Approve reference'}
                    >
                      {r.approved ? <X className="size-3.5" /> : <Check className="size-3.5" />}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      className="h-7"
                      onClick={() => api.deleteElementReference(projectId, e.id, r.id).catch(reportError)}
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
                  onChange={(ev) => setView(ev.target.value as ElementReferenceView)}
                  className="h-7 px-1 text-[11px]"
                  aria-label="Reference view"
                >
                  {ALL_VIEWS.map((v) => (
                    <option key={v} value={v}>
                      {v}
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
                  data-testid="upload-element-reference"
                  onChange={(ev) => {
                    const f = ev.target.files?.[0];
                    if (f) api.uploadElementReference(projectId, e.id, f, view).catch(reportError);
                    ev.target.value = '';
                  }}
                />
              </div>
            ) : null}
          </div>
          {e.references.length > 0 && !locked && approved < e.references.length ? (
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              icon={<Check className="size-3.5" />}
              onClick={async () => {
                try {
                  for (const r of e.references.filter((x) => !x.approved))
                    await api.approveElementReference(projectId, e.id, r.id, true);
                } catch (err) {
                  reportError(err);
                }
              }}
              data-testid="approve-all-element-references"
            >
              Approve all
            </Button>
          ) : null}
        </div>
        <div className="space-y-3">
          <Field label={`Description ${locked ? '(frozen while locked)' : ''}`}>
            {locked ? (
              <div className="min-h-9 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 py-2 text-[13px] text-muted">
                {e.description || '—'}
              </div>
            ) : (
              <Editable
                value={e.description}
                multiline
                rows={3}
                placeholder="What it looks like: shape, materials, colours, light"
                onSave={(v) => api.updateElement(projectId, e.id, { description: v }, `element:${e.id}`)}
                ariaLabel={`${e.name} description`}
              />
            )}
          </Field>
          <Field label="Also called" hint="Other names the screenplay uses, comma separated">
            <Editable
              value={e.aliases.join(', ')}
              placeholder="the lantern room, lamp room"
              onSave={(v) =>
                api.updateElement(projectId, e.id, {
                  aliases: v
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                })
              }
              ariaLabel={`${e.name} aliases`}
            />
          </Field>
        </div>
      </div>
    </Entity>
  );
}

export function ElementsView() {
  const { docs, projectId, workflow } = useProject();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<ElementKind>('location');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  if (!docs || !projectId) return null;
  const inUse = new Set(elementsInUse(docs).map((e) => e.id));
  const all = Object.values(docs.elements);
  const gate = workflow?.stages.find((s) => s.id === 'cast')?.gate;
  const unmet = gate?.requirements.filter((r) => !r.ok && r.id.startsWith('elements.')) ?? [];
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <SectionHeader
        title="Elements"
        subtitle="Locations, props and styles kept consistent like characters: approve references and lock everything the story uses."
        actions={
          <Button
            icon={<Plus className="size-4" />}
            onClick={() => setAdding(true)}
            data-testid="add-element"
          >
            Add element
          </Button>
        }
      />
      {unmet.length && workflow?.stage === 'cast' ? (
        <div
          className="rounded-[var(--radius-control)] border border-warning/40 bg-warning/10 p-3 text-[13px]"
          data-testid="elements-unmet"
        >
          {unmet.map((r) => (
            <p key={r.id}>
              {r.message}
              {r.details?.length ? `: ${r.details.join(', ')}` : ''}
            </p>
          ))}
        </div>
      ) : null}
      {all.length === 0 ? (
        <EmptyState title="No elements yet">
          Generating the screenplay creates its locations and props. You can also add them yourself.
        </EmptyState>
      ) : (
        KINDS.map(({ kind: k, title, hint }) => {
          const list = all
            .filter((e) => e.kind === k)
            .sort(
              (a, b) => Number(inUse.has(b.id)) - Number(inUse.has(a.id)) || a.name.localeCompare(b.name),
            );
          if (!list.length) return null;
          return (
            <section key={k} className="space-y-3" data-testid={`elements-${k}`}>
              <div>
                <h3 className="font-semibold">{title}</h3>
                <p className="text-[12px] text-muted">{hint}</p>
              </div>
              {list.map((e) => (
                <ElementCard key={e.id} e={e} inUse={inUse.has(e.id)} />
              ))}
            </section>
          );
        })
      )}
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add element"
        footer={
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={() =>
              api
                .createElement(projectId, { kind, name, description })
                .then(() => {
                  setAdding(false);
                  setName('');
                  setDescription('');
                })
                .catch(reportError)
            }
            data-testid="add-element-submit"
          >
            Add
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Kind">
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as ElementKind)}
              data-testid="new-element-kind"
            >
              <option value="location">Location</option>
              <option value="prop">Prop</option>
              <option value="style">Style</option>
            </Select>
          </Field>
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Lamp room"
              data-testid="new-element-name"
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="circular brass-framed lantern room, salt-crusted windows"
            />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
