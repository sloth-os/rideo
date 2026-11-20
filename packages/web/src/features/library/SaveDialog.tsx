import type { LibrarySaveInput } from '@rideo/shared';
import { UserCheck } from 'lucide-react';
import { useState } from 'react';
import { Button, cx, Dialog, Field, Input, Textarea } from '../../components/ui';
import { useUi } from '../../store/ui';
import { libraryApi } from './api';
import { type SaveTarget, useLibraryScope } from './context';
import { consentSubjectsOf, latestOf, libraryErrorText, parseTags } from './words';

/**
 * Save to library (docs/design/library.md#save-to-library): a new version of the item the entity is linked to, or a
 * new item (name, description, tags), with a note; a real person's consent confirmed; a version saved meanwhile
 * (`412`) offers Update…, Save anyway as the next version, or Save as a new item. The answer says what happened.
 */
export function SaveDialog({ target, onClose }: { target: SaveTarget; onClose: () => void }) {
  const scope = useLibraryScope();
  const linked = target.library;
  const link = scope?.linkOf(target.kind, target.id);
  const itemName = link?.item?.name ?? null;
  const [mode, setMode] = useState<'version' | 'item'>(
    linked && link?.state !== 'missing' ? 'version' : 'item',
  );
  const [name, setName] = useState(target.name);
  const [description, setDescription] = useState('');
  const [tagText, setTagText] = useState('');
  const [note, setNote] = useState('');
  const [consent, setConsent] = useState(false);
  const [askConsent, setAskConsent] = useState(target.realPerson);
  const [subjects, setSubjects] = useState<{ what: string; subject: string | null; scope: string | null }[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<number | null>(null);
  if (!scope) return null;
  const { tags, invalid } = parseTags(tagText);
  const newItem = mode === 'item';
  const save = async (basedOn?: number) => {
    setBusy(true);
    setError(null);
    const input: LibrarySaveInput = newItem
      ? {
          entity: { kind: target.kind, id: target.id },
          ...(linked ? { newItem: true } : {}),
          name: name.trim() || target.name,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(tags.length ? { tags } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(askConsent ? { acknowledgeConsent: consent } : {}),
        }
      : {
          entity: { kind: target.kind, id: target.id },
          itemId: linked!.itemId,
          basedOn: basedOn ?? linked!.version,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(askConsent ? { acknowledgeConsent: consent } : {}),
        };
    try {
      const out = await libraryApi.save(scope.projectId, input);
      useUi
        .getState()
        .toast(
          out.unchanged
            ? `Nothing changed since v${out.version.version}: ${target.name} stays linked to ${out.item.name}`
            : `Saved ${out.item.name} v${out.version.version} to the library`,
          out.unchanged ? 'info' : 'success',
        );
      scope.refresh();
      onClose();
    } catch (err) {
      const named = consentSubjectsOf(err);
      if (named.length || (err as { code?: string }).code === 'consent_required') {
        setAskConsent(true);
        setSubjects(named);
      }
      setLatest(latestOf(err));
      setError(libraryErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  const blocked = busy || (askConsent && !consent) || invalid.length > 0 || (newItem && !name.trim());
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Save ${target.name} to the library`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {latest && !newItem ? (
            <>
              {target.kind !== 'resource' ? (
                <Button
                  onClick={() => {
                    scope.openPlan({
                      itemId: linked!.itemId,
                      version: latest,
                      target: {
                        kind: target.kind as 'character' | 'element',
                        id: target.id,
                        name: target.name,
                      },
                      fromVersion: linked!.version,
                    });
                    onClose();
                  }}
                  data-testid="save-take-latest"
                >
                  Update…
                </Button>
              ) : null}
              <Button
                variant="primary"
                loading={busy}
                disabled={blocked}
                onClick={() => save(latest)}
                data-testid="save-anyway"
              >
                Save anyway as v{latest + 1}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              loading={busy}
              disabled={blocked}
              onClick={() => save()}
              data-testid="save-to-library-submit"
            >
              Save
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3" data-testid="save-to-library-dialog">
        {linked ? (
          <fieldset className="space-y-2">
            <legend className="sr-only">Where it goes</legend>
            <Choice
              checked={!newItem}
              disabled={link?.state === 'missing'}
              onChange={() => setMode('version')}
              testid="save-as-version"
              label={`Save as a new version of ${itemName ?? 'its library item'} v${linked.version}`}
              hint={
                link?.state === 'missing'
                  ? 'This studio does not have the item it is linked to.'
                  : 'Projects that use it see the new version and update when they choose.'
              }
            />
            <Choice
              checked={newItem}
              onChange={() => setMode('item')}
              testid="save-as-item"
              label="Save as a new item"
              hint="A separate item; this entity links to it instead."
            />
          </fieldset>
        ) : (
          <p className="text-[13px] text-muted">
            A new library item: other projects of the studio can use it with the same id and seed.
          </p>
        )}
        {newItem ? (
          <>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="save-name" />
            </Field>
            <Field label="Description">
              <Textarea
                value={description}
                rows={2}
                onChange={(e) => setDescription(e.target.value)}
                data-testid="save-description"
              />
            </Field>
            <Field label="Tags" hint="Comma separated, lower case: season 1, harbour town">
              <Input value={tagText} onChange={(e) => setTagText(e.target.value)} data-testid="save-tags" />
            </Field>
            {invalid.length ? (
              <p className="text-[12px] text-danger" data-testid="save-tags-invalid">
                Not a tag: {invalid.join(', ')} (1–40 lower-case letters, digits, spaces, _ . -)
              </p>
            ) : null}
          </>
        ) : null}
        <Field label="Note" hint="What changed, for whoever updates to it">
          <Input value={note} onChange={(e) => setNote(e.target.value)} data-testid="save-note" />
        </Field>
        {askConsent ? (
          <label
            className="flex items-start gap-2 rounded-[var(--radius-control)] border border-info/40 bg-info/10 px-3 py-2 text-[13px]"
            data-testid="save-consent"
          >
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--color-accent)]"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              data-testid="save-consent-check"
            />
            <span>
              <span className="flex items-center gap-1 font-medium">
                <UserCheck className="size-3.5" /> A real person
              </span>
              The consent covers using this likeness and voice in other projects of the studio.
              {subjects.length ? (
                <span className="mt-1 block text-[12px] text-muted">
                  {subjects
                    .map(
                      (s) => `${s.subject ?? 'someone'} (${s.what}${s.scope ? `, consent: ${s.scope}` : ''})`,
                    )
                    .join('; ')}
                </span>
              ) : null}
            </span>
          </label>
        ) : null}
        {error ? (
          <p className="text-[13px] text-danger" role="alert" data-testid="save-error">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function Choice({
  checked,
  disabled,
  onChange,
  label,
  hint,
  testid,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
  hint: string;
  testid: string;
}) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-2 rounded-[var(--radius-control)] border px-3 py-2 text-[13px]',
        checked ? 'border-accent bg-accent/10' : 'border-border bg-surface-2',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="radio"
        name="save-where"
        className="mt-0.5 accent-[var(--color-accent)]"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        data-testid={testid}
      />
      <span>
        <span className="block font-medium">{label}</span>
        <span className="text-muted">{hint}</span>
      </span>
    </label>
  );
}
