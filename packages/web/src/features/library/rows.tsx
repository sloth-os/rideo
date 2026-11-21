import {
  type Character,
  deskUnitKindFor,
  type Element,
  isRealPersonCharacter,
  type Resource,
} from '@rideo/shared';
import { Box, LibraryBig, Link2Off } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui';
import { useUi } from '../../store/ui';
import { libraryApi } from './api';
import { type EntityKind, useLibraryScope } from './context';
import { appliedText, deskRowText, libraryErrorText, libraryRowText, offeredVersion } from './words';

/**
 * The library on a project's cards (docs/design/library.md#cast-elements-and-resources): Save to library, Use from
 * library, the library row of a linked entity and the 3D row of a character, location or prop. They work inside the
 * view's `LibraryProvider`; outside one they show nothing.
 */

type Entity = Character | Element | Resource;

const failed = (err: unknown) => useUi.getState().toast(libraryErrorText(err), 'error');

/** Save to library on a card: a new item, or a new version of the item it is linked to. */
export function SaveToLibraryButton({ kind, entity }: { kind: EntityKind; entity: Entity }) {
  const scope = useLibraryScope();
  if (!scope) return null;
  const allowed = scope.canEdit && scope.canPublish;
  return (
    <Button
      size="sm"
      icon={<LibraryBig className="size-3.5" />}
      disabled={!allowed}
      title={
        allowed
          ? 'Save it to the studio library, for other projects to use'
          : 'Saving to the library needs an editor who may publish to it'
      }
      onClick={() =>
        scope.openSave({
          kind,
          id: entity.id,
          name: entity.name,
          library: entity.library ? { itemId: entity.library.itemId, version: entity.library.version } : null,
          realPerson: kind === 'character' && isRealPersonCharacter(entity as Character),
        })
      }
      data-testid="save-to-library"
    >
      Save to library
    </Button>
  );
}

/** Use from library in a view's header. */
export function UseFromLibraryButton({ kind }: { kind: EntityKind }) {
  const scope = useLibraryScope();
  if (!scope) return null;
  return (
    <Button
      icon={<LibraryBig className="size-4" />}
      disabled={!scope.canEdit}
      title={scope.canEdit ? undefined : 'Editors and directors add to the project'}
      onClick={() => scope.openUse(kind)}
      data-testid="use-from-library"
    >
      Use from library
    </Button>
  );
}

const rowClass =
  'flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 py-2 text-[13px]';

/** "Library: Mira v2 · v3 available [Update…] [Unlink]" on a linked entity. */
export function LibraryRow({ kind, entity }: { kind: EntityKind; entity: Entity }) {
  const scope = useLibraryScope();
  const [busy, setBusy] = useState(false);
  if (!scope || !entity.library) return null;
  const origin = entity.library;
  const link = scope.linkOf(kind, entity.id);
  const offered = offeredVersion(link);
  // Using a resource's other version adds another resource: once one holds it, the row names that one instead
  const holder =
    kind === 'resource' && offered
      ? Object.values(scope.docs.resources).find(
          (r) => r.id !== entity.id && r.library?.itemId === origin.itemId && r.library.version === offered,
        )
      : undefined;
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      useUi.getState().toast(await fn(), 'success');
      scope.refresh();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={rowClass} data-testid="library-row">
      <LibraryBig className="size-3.5 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 break-words" data-testid="library-row-text">
        {libraryRowText(origin.version, link, holder?.name)}
      </span>
      {offered && kind !== 'resource' ? (
        <Button
          size="sm"
          className="h-7"
          disabled={!scope.canEdit || busy}
          onClick={() =>
            scope.openPlan({
              itemId: origin.itemId,
              version: offered,
              target: { kind, id: entity.id, name: entity.name },
              fromVersion: origin.version,
            })
          }
          data-testid="library-update"
        >
          Update…
        </Button>
      ) : null}
      {offered && kind === 'resource' && !holder ? (
        <Button
          size="sm"
          className="h-7"
          loading={busy}
          disabled={!scope.canEdit}
          title="Adds that version as a new resource: shots keep the one they use"
          onClick={() =>
            run(async () =>
              appliedText(
                await libraryApi.apply(scope.projectId, { itemId: origin.itemId, version: offered }),
              ),
            )
          }
          data-testid="library-use-version"
        >
          Use v{offered}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        icon={<Link2Off className="size-3.5" />}
        disabled={!scope.canEdit || busy}
        title="Keep it as the project's own, no longer linked to the library"
        onClick={() =>
          run(async () => {
            await libraryApi.detach(scope.projectId, { target: { kind, id: entity.id }, what: 'library' });
            return `${entity.name} is no longer linked to the library`;
          })
        }
        data-testid="library-unlink"
      >
        Unlink
      </Button>
    </div>
  );
}

/** "3D figure: Mira look v1 · v2 available [Use v2] [Change] [Unlink]", or "3D set: none [Choose…]". */
export function DeskRow({ kind, entity }: { kind: 'character' | 'element'; entity: Character | Element }) {
  const scope = useLibraryScope();
  const [busy, setBusy] = useState(false);
  const deskKind =
    kind === 'character'
      ? deskUnitKindFor({ kind: 'character' })
      : deskUnitKindFor({ kind: 'element', elementKind: (entity as Element).kind });
  if (!scope || !deskKind) return null;
  const pin = entity.deskUnit ?? null;
  const link = scope.pinOf(kind, entity.id);
  const offered = offeredVersion(link);
  const target = { kind, id: entity.id, name: entity.name };
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      useUi.getState().toast(await fn(), 'success');
      scope.refresh();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };
  const readOnly = !scope.canEdit;
  const choose = () => scope.openDesk({ deskKind, target, currentItemId: pin?.itemId ?? null });
  return (
    <div className={rowClass} data-testid="desk-row" data-kind={deskKind}>
      <Box className="size-3.5 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 break-words" data-testid="desk-row-text">
        {deskRowText(deskKind, pin, link)}
      </span>
      {pin && offered ? (
        <Button
          size="sm"
          className="h-7"
          loading={busy}
          disabled={readOnly}
          onClick={() =>
            run(async () =>
              appliedText(
                await libraryApi.apply(scope.projectId, {
                  itemId: pin.itemId,
                  version: offered,
                  target: { kind, id: entity.id },
                }),
              ),
            )
          }
          data-testid="desk-use-version"
        >
          Use v{offered}
        </Button>
      ) : null}
      <Button
        size="sm"
        className="h-7"
        disabled={readOnly || busy}
        onClick={choose}
        data-testid={pin ? 'desk-change' : 'desk-choose'}
      >
        {pin ? 'Change' : 'Choose…'}
      </Button>
      {pin ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          icon={<Link2Off className="size-3.5" />}
          disabled={readOnly || busy}
          title="Its scenes go back to the words at their next Update shots"
          onClick={() =>
            run(async () => {
              await libraryApi.detach(scope.projectId, { target: { kind, id: entity.id }, what: 'deskUnit' });
              return `${entity.name} no longer uses ${pin.name}`;
            })
          }
          data-testid="desk-unlink"
        >
          Unlink
        </Button>
      ) : null}
    </div>
  );
}

/** The library row and the 3D row of a card, where they apply. */
export function LibraryRows({ kind, entity }: { kind: EntityKind; entity: Entity }) {
  const scope = useLibraryScope();
  if (!scope) return null;
  return (
    <div className="space-y-2" data-testid="library-rows">
      <LibraryRow kind={kind} entity={entity} />
      {kind !== 'resource' ? <DeskRow kind={kind} entity={entity as Character | Element} /> : null}
    </div>
  );
}
