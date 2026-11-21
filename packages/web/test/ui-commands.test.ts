import type { AuthMe, UiCommand } from '@rideo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../src/lib/auth';
import { handleAgentUi, handleUiCommand } from '../src/lib/ui-commands';
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

// docs/design/realtime-sync.md#who-sees-and-steers-which-tabs: the auth mode the tab decides with
describe('agent UI commands before the tab knows its auth mode', () => {
  const me = (mode: AuthMe['mode']): AuthMe =>
    ({ mode, provider: null, user: null, token: null, admin: false }) as unknown as AuthMe;
  /** `/api/auth/me` answered by hand: each ask waits for the next `answer` (a mode, or a failure). */
  function authServer() {
    const asks: ((r: AuthMe | Error) => void)[] = [];
    const fetch = vi.fn(async (url: string) => {
      expect(url).toMatch(/\/api\/auth\/me$/);
      const answer = await new Promise<AuthMe | Error>((resolve) => asks.push(resolve));
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    return {
      fetch,
      answer: async (r: AuthMe | Error) => {
        await vi.waitFor(() => expect(asks.length).toBeGreaterThan(0));
        asks.shift()?.(r);
      },
    };
  }
  const elsewhere: UiCommand = { ...base, projectId: other, action: 'navigate', params: { view: 'cast' } };
  /** A promise's state now: settled or not. */
  const settled = async (p: Promise<unknown>) => {
    let done = false;
    void p.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    return done;
  };

  beforeEach(() => {
    useAuth.setState({ me: null, loaded: false });
    useProject.getState().clear();
    useUi.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('in auth mode none, waits for /api/auth/me and then carries out a command for another project', async () => {
    const server = authServer();
    // the studio asks who is signed in when it opens; the live channel is faster
    const loading = useAuth.getState().load();
    const navigate = vi.fn();
    const handled = handleAgentUi(elsewhere, () => ({ navigate, path: onProject }));
    expect(await settled(handled)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    await server.answer(me('none'));
    await expect(handled).resolves.toBeUndefined();
    await loading;
    expect(navigate).toHaveBeenCalledWith(`/p/${other}/cast`);
    // one ask, shared by the studio and the command
    expect(server.fetch).toHaveBeenCalledTimes(1);
  });

  it('asks again when the first ask failed, and refuses only once it knows the mode', async () => {
    const server = authServer();
    const loading = useAuth.getState().load();
    await server.answer(new TypeError('Failed to fetch'));
    await loading;
    expect(useAuth.getState()).toMatchObject({ me: null, loaded: true });
    const navigate = vi.fn();
    const handled = handleAgentUi(elsewhere, () => ({ navigate, path: onProject }));
    await server.answer(me('none'));
    await expect(handled).resolves.toBeUndefined();
    expect(navigate).toHaveBeenCalledWith(`/p/${other}/cast`);
    expect(server.fetch).toHaveBeenCalledTimes(2);
    // with accounts, a command for another project is refused once the answer says so
    useAuth.setState({ me: null, loaded: false });
    const refused = handleAgentUi(elsewhere, () => ({ navigate, path: onProject }));
    await server.answer(me('oidc'));
    await expect(refused).rejects.toThrow('this tab shows another project');
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('reads where the tab is once the answer is in, and never waits for a command for the project it shows', async () => {
    const server = authServer();
    const navigate = vi.fn();
    let path = onProject;
    // the person opens the command's project while the tab waits: it is carried out, whatever the mode
    const moved = handleAgentUi(
      { ...elsewhere, action: 'focus', params: { target: { kind: 'element', id: 'el_1' } } },
      () => ({
        navigate,
        path,
      }),
    );
    path = `/p/${other}/story`;
    await server.answer(me('token'));
    await expect(moved).resolves.toBeUndefined();
    expect(navigate).toHaveBeenCalledWith(`/p/${other}/elements`);
    // the shown project's commands and toasts without a project are carried out at once, with nothing asked
    server.fetch.mockClear();
    useAuth.setState({ me: null, loaded: false });
    await handleAgentUi({ ...base, action: 'navigate', params: { view: 'clips' } }, () => ({
      navigate,
      path: onProject,
    }));
    expect(navigate).toHaveBeenLastCalledWith(`/p/${pid}/clips`);
    await handleAgentUi(
      { id: 'cmd_3', issuedBy: agent, action: 'notify', params: { message: 'For this person' } },
      () => ({ navigate, path: '/' }),
    );
    expect(useUi.getState().toasts.map((t) => t.message)).toEqual(['For this person']);
    expect(server.fetch).not.toHaveBeenCalled();
  });
});
