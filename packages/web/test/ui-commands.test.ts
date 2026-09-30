import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUiCommand } from '../src/lib/ui-commands';
import { useProject } from '../src/store/project';
import { useUi } from '../src/store/ui';

const agent = { kind: 'agent' as const, id: 'claude-code', name: 'Claude Code' };
const base = { id: 'cmd_1', issuedBy: agent, projectId: 'prj_01m3s0000000000000' };

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
      '/',
    );
    expect(navigate).toHaveBeenCalledWith('/p/prj_01m3s0000000000000/clips?clip=a');
    navigate.mockClear();
    await handleUiCommand(
      { ...base, action: 'navigate', params: { view: 'clips', params: { clip: 'a' } } },
      navigate,
      '/p/prj_01m3s0000000000000/clips?clip=a',
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('focuses entities on the view that shows them', async () => {
    const navigate = vi.fn();
    await handleUiCommand(
      { ...base, action: 'focus', params: { target: { kind: 'character', id: 'chr_x' } } },
      navigate,
      '/',
    );
    expect(navigate).toHaveBeenCalledWith('/p/prj_01m3s0000000000000/cast');
    expect(useProject.getState().highlight).toMatchObject({ kind: 'character', id: 'chr_x' });
    await handleUiCommand(
      { ...base, action: 'focus', params: { target: { kind: 'take', id: 'tak_x' } } },
      navigate,
      '/',
    );
    expect(navigate).toHaveBeenLastCalledWith('/p/prj_01m3s0000000000000/clips');
  });

  it('shows notifications attributed to the agent and drives the player', async () => {
    await handleUiCommand(
      { ...base, action: 'notify', params: { message: 'Pilot ready', level: 'success' } },
      vi.fn(),
      '/',
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
      '/',
    );
    expect(navigate).toHaveBeenCalledWith('/p/prj_01m3s0000000000000/editor');
    expect(useProject.getState().playerCommand).toMatchObject({ action: 'seek', time: 12 });
    await expect(handleUiCommand({ ...base, action: 'navigate', params: {} }, vi.fn(), '/')).rejects.toThrow(
      /view/,
    );
  });
});
