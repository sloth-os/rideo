import type { LibraryProjectStatus, ProjectDocs } from '@rideo/shared';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth, useProjectRole } from '../../lib/auth';
import { mayPublish } from './access';
import { libraryApi } from './api';
import {
  type DeskRequest,
  type EntityKind,
  LibraryScope,
  type LibraryScopeValue,
  linkSignature,
  type PlanRequest,
  type SaveTarget,
} from './context';
import { DeskPicker } from './DeskPicker';
import { PlanDialog } from './PlanDialog';
import { SaveDialog } from './SaveDialog';
import { UsePicker } from './UsePicker';

type Main =
  | { kind: 'save'; target: SaveTarget }
  | { kind: 'desk'; request: DeskRequest }
  | { kind: 'use'; entityKind: EntityKind }
  | null;

/**
 * The library of one project view (docs/design/library.md#cast-elements-and-resources): its links and pins from
 * `GET /api/projects/:id/library`, read again when a linked entity changes, after an action and when the tab comes
 * back (a version published elsewhere), and the dialogs: one of Save, the 3D picker and Use from library, and the
 * plan of an update or a link over it.
 */
export function LibraryProvider({
  projectId,
  docs,
  children,
}: {
  projectId: string;
  docs: ProjectDocs;
  children: ReactNode;
}) {
  const role = useProjectRole(docs.project);
  const canEdit = role.can('project.edit');
  const canApprove = role.can('project.approve');
  const canPublish = mayPublish(useAuth((s) => s.me));
  const [status, setStatus] = useState<LibraryProjectStatus | null>(null);
  const [round, setRound] = useState(0);
  const [main, setMain] = useState<Main>(null);
  const [plan, setPlan] = useState<PlanRequest | null>(null);
  const signature = useMemo(() => linkSignature(docs), [docs]);
  const refresh = useCallback(() => setRound((r) => r + 1), []);
  // a linked entity that changes, and `round`, ask for the status again
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      libraryApi.status(projectId).then(
        (s) => live && setStatus(s),
        // the rows fall back to what the documents say (no names, nothing "available")
        () => undefined,
      );
    }, 100);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [projectId, signature, round]);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  const value = useMemo<LibraryScopeValue>(() => {
    const find = (kind: EntityKind, id: string, via: 'library' | 'deskUnit') =>
      status?.links.find((l) => l.via === via && l.entity.kind === kind && l.entity.id === id);
    return {
      projectId,
      docs,
      status,
      refresh,
      canEdit,
      canApprove,
      canPublish,
      linkOf: (kind, id) => find(kind, id, 'library'),
      pinOf: (kind, id) => find(kind, id, 'deskUnit'),
      openSave: (target) => setMain({ kind: 'save', target }),
      openPlan: (request) => setPlan(request),
      openDesk: (request) => setMain({ kind: 'desk', request }),
      openUse: (entityKind) => setMain({ kind: 'use', entityKind }),
    };
  }, [projectId, docs, status, refresh, canEdit, canApprove, canPublish]);
  const close = useCallback(() => setMain(null), []);
  const closePlan = useCallback(() => setPlan(null), []);
  return (
    <LibraryScope.Provider value={value}>
      {children}
      {main?.kind === 'save' ? <SaveDialog target={main.target} onClose={close} /> : null}
      {main?.kind === 'desk' ? <DeskPicker request={main.request} onClose={close} /> : null}
      {main?.kind === 'use' ? <UsePicker entityKind={main.entityKind} onClose={close} /> : null}
      {plan ? <PlanDialog request={plan} onClose={closePlan} /> : null}
    </LibraryScope.Provider>
  );
}
