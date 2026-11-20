import type { UiCommand } from '@rideo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUiCommand } from '../src/lib/ui-commands';
import { useProject } from '../src/store/project';
import { useUi } from '../src/store/ui';

const agent = { kind: 'agent' as const, id: 'claude-code', name: 'Claude Code' };
const pid = 'prj_01m3s0000000000000';
const other = 'prj_01m3s0000000000001';
const base = { id: 'cmd_1', issuedBy: agent, projectId: pid };
/** The tab shows the command's project. */
const onProject = `/p/${pid}/story`;

describe('agent UI commands', () => {
  beforeEach(() => {
    useProject.getState().clear();
    useUi.setState({ toasts: [] });
  });

  it('navigates to a project view with params', async () => {
    const navigate = vi.fn();
    await handleUiCommand(
      { ...base, action: 'navigate', params: { view: 'clips', params: { clip: 'a' } } },
      navigate,
      onProject,
    );
    expect(navigate).toHaveBeenCalledWith(`/p/${pid}/clips?clip=a`);
    navigate.mockClear();
    await handleUiCommand(
      { ...base, action: 'navigate', params: { view: 'clips', params: { clip: 'a' } } },
      navigate,
      `/p/${pid}/clips?clip=a`,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('focuses entities on the view that shows them', async () => {
    const navigate = vi.fn();
    await handleUiCommand(
      { ...base, action: 'focus', params: { target: { kind: 'character', id: 'chr_x' } } },
      navigate,
      onProject,
    );
    expect(navigate).toHaveBeenCalledWith(`/p/${pid}/cast`);
    expect(useProject.getState().highlight).toMatchObject({ kind: 'character', id: 'chr_x' });
    await handleUiCommand(
      { ...base, action: 'focus', params: { target: { kind: 'take', id: 'tak_x' } } },
      navigate,
      onProject,
    );
    expect(navigate).toHaveBeenLastCalledWith(`/p/${pid}/clips`);
  });

  it('shows notifications attributed to the agent and drives the player', async () => {
    await handleUiCommand(
      { ...base, action: 'notify', params: { message: 'Pilot ready', level: 'success' } },
      vi.fn(),
      onProject,
    );
    expect(useUi.getState().toasts[0]).toMatchObject({
      message: 'Pilot ready',
      level: 'success',
      actor: agent,
    });
    const navigate = vi.fn();
    await handleUiCommand(
      { ...base, action: 'player', params: { playerAction: 'seek', time: 12 } },
      navigate,
      onProject,
    );
    expect(navigate).toHaveBeenCalledWith(`/p/${pid}/editor`);
    expect(useProject.getState().playerCommand).toMatchObject({ action: 'seek', time: 12 });
    await expect(
      handleUiCommand({ ...base, action: 'navigate', params: {} }, vi.fn(), onProject),
    ).rejects.toThrow(/view/);
  });

  // docs/design/realtime-sync.md#who-sees-and-steers-which-tabs
  it('leaves a command for a project the tab does not show alone, and says so', async () => {
    const commands: UiCommand[] = [
      { ...base, projectId: other, action: 'navigate', params: { view: 'clips' } },
      { ...base, projectId: other, action: 'focus', params: { target: { kind: 'character', id: 'chr_x' } } },
      { ...base, projectId: other, action: 'notify', params: { message: 'Not for this tab' } },
      { ...base, projectId: other, action: 'player', params: { playerAction: 'play' } },
    ];
    // the tab shows another project, or none (the home page, settings)
    for (const path of [onProject, '/', '/settings'])
      for (const cmd of commands) {
        const navigate = vi.fn();
        await expect(handleUiCommand(cmd, navigate, path)).rejects.toThrow('this tab shows another project');
        expect(navigate).not.toHaveBeenCalled();
      }
    expect(useUi.getState().toasts).toEqual([]);
    expect(useProject.getState().highlight).toBeNull();
    expect(useProject.getState().playerCommand).toBeNull();
    // a toast without a project is for whichever project the tab shows
    await handleUiCommand(
      { id: 'cmd_2', issuedBy: agent, action: 'notify', params: { message: 'For this person' } },
      vi.fn(),
      '/',
    );
    expect(useUi.getState().toasts.map((t) => t.message)).toEqual(['For this person']);
  });

  it('carries out commands for any project in auth mode none, as before', async () => {
    const navigate = vi.fn();
    await handleUiCommand(
      { ...base, projectId: other, action: 'navigate', params: { view: 'cast' } },
      navigate,
      onProject,
      { anyProject: true },
    );
    expect(navigate).toHaveBeenCalledWith(`/p/${other}/cast`);
    await handleUiCommand(
      { ...base, action: 'focus', params: { target: { kind: 'character', id: 'chr_x' } } },
      navigate,
      '/',
      { anyProject: true },
    );
    expect(navigate).toHaveBeenLastCalledWith(`/p/${pid}/cast`);
    expect(useProject.getState().highlight).toMatchObject({ kind: 'character', id: 'chr_x' });
  });
});
