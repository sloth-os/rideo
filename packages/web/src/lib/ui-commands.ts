import type { FocusKind, UiCommand, View } from '@rideo/shared';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';

export const VIEW_FOR_KIND: Record<FocusKind, View> = {
  scene: 'story',
  beat: 'story',
  character: 'cast',
  clip: 'clips',
  shot: 'clips',
  take: 'clips',
  'timeline-item': 'editor',
  commit: 'history',
  job: 'overview',
  resource: 'resources',
  suggestion: 'analysis',
  export: 'exports',
};

export type Navigate = (to: string) => void;

/** Executes an agent UI command in this tab (docs/design/realtime-sync.md#ui-commands). */
export async function handleUiCommand(
  cmd: UiCommand,
  navigate: Navigate,
  currentPath: string,
): Promise<void> {
  const { params, projectId } = cmd;
  const go = (view: View, extra?: Record<string, string>) => {
    if (!projectId) return;
    const qs = extra && Object.keys(extra).length ? `?${new URLSearchParams(extra)}` : '';
    const target = `/p/${projectId}/${view}${qs}`;
    if (currentPath !== target) navigate(target);
  };
  switch (cmd.action) {
    case 'navigate':
      if (!params.view) throw new Error('navigate needs a view');
      go(params.view, params.params);
      return;
    case 'focus': {
      if (!params.target) throw new Error('focus needs a target');
      go(VIEW_FOR_KIND[params.target.kind]);
      await new Promise((r) => setTimeout(r, 50));
      useProject.getState().focus(params.target.kind, params.target.id);
      return;
    }
    case 'notify':
      useUi.getState().toast(params.message ?? '', params.level ?? 'info', cmd.issuedBy);
      return;
    case 'player':
      go('editor');
      useProject.getState().player(params.playerAction ?? 'play', params.time);
      return;
  }
}
