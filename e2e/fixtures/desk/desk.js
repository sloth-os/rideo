// A stand-in for the 3D-Editor's desk page (docs/design/director-desk.md#tests): the desk side of the embed protocol,
// version 1, from the contract's fixtures' shapes. It stages nothing: it shows the brief's shots and the state it was
// given, and makes a state of its own text (the same bytes again for an unchanged scene). Like the real desk, it has a
// Follow menu of its own, preselected from `options.defaultMode` (else the first of `options.modes`), and its Send
// renders that mode only: a result for every shot (a real H.264 clip in that mode and a PNG still of the brief's size,
// as bytes) whose frames, size and rate come from the brief. Its Send part leaves the last shot out and names it in an
// `error` `export_failed` after the result, the way the real desk reports a shot it could not render; its Send longer
// renders the first shot half a second longer than the brief, with the `brief_length` issue the real desk gives it: a
// length changed in the desk says to set it back, and a shot the brief retimed since it was staged points to Update
// shots. A given state that starts with `unreadable` is one it cannot read (`error` `state_unreadable`, then `opened`
// from the brief, and no `state` until an edit or a `save`: opening cannot replace the host's copy); one that starts
// with `retimed` was staged before the brief retimed the first shot: `opened` lists that shot in `changes.retimed`, and
// its Update shots brings it to the brief (an edit, so a `state` follows) and off the list, as the real desk's does.
(() => {
  const $ = (id) => document.querySelector(`[data-testid="${id}"]`);
  const encode = (text) => new TextEncoder().encode(text).buffer;
  const decode = (buffer) => new TextDecoder().decode(buffer);
  let port = null;
  let scene = null;
  let current = '';
  let edits = 0;
  let results = 0;
  /** The shots the brief retimed since the given state was staged, until Update shots (the desk's live changes). */
  let retimed = [];
  const clipBytes = fetch('clip.mp4').then((r) => r.arrayBuffer());
  /** A PNG of the brief's size, as the desk's stills are. */
  const stillOf = (width, height) =>
    new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      g.fillStyle = '#8a8f99';
      g.fillRect(0, 0, width, height);
      g.fillStyle = '#c9ccd3';
      g.fillRect(width / 4, height / 4, width / 2, height / 2);
      canvas.toBlob((blob) => resolve(blob.arrayBuffer()), 'image/png');
    });

  const stateOf = (id) => ({
    type: 'state',
    ...(id ? { id } : {}),
    sceneId: scene.id,
    state: { format: '3d-editor.desk-state', version: 1, data: encode(current) },
    shots: scene.shots.length,
  });
  const show = () => {
    $('desk-current').textContent = current;
    $('desk-retimed').textContent = retimed.join(', ');
  };

  const onPort = (event) => {
    const m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'open') {
      if (scene)
        return port.postMessage({ type: 'error', code: 'busy', message: 'The scene is open already.' });
      scene = m.scene;
      const given = m.state ? decode(m.state.data) : null;
      // a state this desk cannot read: the brief is staged, and the host is told
      const unreadable = given?.startsWith('unreadable') ?? false;
      if (unreadable)
        port.postMessage({
          type: 'error',
          code: 'state_unreadable',
          message: 'the state was saved by a desk this one does not read',
        });
      current = given && !unreadable ? given : `staged ${scene.id}`;
      retimed = given?.startsWith('retimed') ? [scene.shots[0].id] : [];
      $('desk-connected').textContent = 'open';
      $('desk-scene').textContent = scene.name;
      $('desk-options').textContent = JSON.stringify(m.options ?? {});
      // the desk's own Follow menu, preselected as the host asks
      $('desk-follow').value = m.options?.defaultMode ?? m.options?.modes?.[0] ?? 'camera';
      $('desk-given').textContent = given ?? 'none';
      $('desk-shots').replaceChildren(
        ...scene.shots.map((shot) => {
          const li = document.createElement('li');
          li.dataset.testid = 'desk-shot';
          li.textContent = `${shot.id} · ${shot.durationSec} s · ${shot.castIds.length} cast`;
          return li;
        }),
      );
      show();
      port.postMessage({
        type: 'opened',
        sceneId: scene.id,
        source: given && !unreadable ? 'state' : 'brief',
        changes: retimed.length
          ? { added: [], removed: [], retimed: [...retimed], recast: [], cast: { added: [], removed: [] } }
          : null,
      });
      // after a state it could not read, the brief's staging is not sent on its own
      if (!unreadable) port.postMessage(stateOf());
    } else if (m.type === 'save') {
      port.postMessage(stateOf(m.id));
    } else if (m.type === 'result-ack') {
      $('desk-ack').textContent = `${m.ok ? 'ok' : 'refused'}: ${m.message ?? ''}`;
    }
  };

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (port || event.source !== window.parent || !m || m.protocol !== '3d-desk' || m.type !== 'connect')
      return;
    if (m.version !== 1 || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = onPort;
    $('desk-connected').textContent = 'connected';
    port.postMessage({
      type: 'ready',
      deskVersion: '0.0.0-e2e',
      protocol: 1,
      capabilities: {
        export: {
          available: true,
          reason: null,
          container: 'mp4',
          videoCodec: 'avc1',
          modes: ['motion', 'pose', 'camera'],
        },
        offline: true,
      },
    });
  });

  $('desk-edit').addEventListener('click', () => {
    if (!scene) return;
    current = `${current} +edit${++edits}`;
    show();
    port.postMessage(stateOf());
  });

  // Update shots: the shots the brief retimed take the brief's length, an edit of the scene
  $('desk-update-shots').addEventListener('click', () => {
    if (!scene || !retimed.length) return;
    retimed = [];
    current = `${current} +updated`;
    show();
    port.postMessage(stateOf());
  });

  /**
   * A result for the brief's shots in the Follow menu's mode only, or all but the last (`part`), which an `error`
   * `export_failed` then names; `longer` renders the first shot half a second longer than the brief.
   */
  const send = async (part, longer) => {
    if (!scene) return;
    const clip = await clipBytes;
    const still = await stillOf(scene.width, scene.height);
    const mode = $('desk-follow').value;
    const files = [];
    const last = scene.shots.at(-1);
    const rendered = part ? scene.shots.slice(0, -1) : scene.shots;
    const shots = rendered.map((shot, i) => {
      const asked = Math.max(1, Math.round(shot.durationSec * scene.fps));
      const frames = longer && i === 0 ? asked + Math.round(scene.fps / 2) : asked;
      const name = `${shot.id}.${mode}.mp4`;
      files.push({ name, mime: 'video/mp4', data: clip.slice(0) });
      files.push({ name: `${shot.id}.still.png`, mime: 'image/png', data: still.slice(0) });
      const sec = (n) => `${Math.round((n / scene.fps) * 1000) / 1000} s`;
      return {
        shotId: shot.id,
        frames,
        durationSec: frames / scene.fps,
        references: { [mode]: name },
        still: `${shot.id}.still.png`,
        camera: { lensMm: 40, move: 'dolly_left' },
        line: 'Everyone stands where the brief puts them.',
        moves: null,
        // the brief's last shot: its camera disagrees with the planned layout
        planAgrees: shot.id === last.id ? false : null,
        // another length than the brief's, as the real desk says it: whose change it is decides what to do
        issues:
          frames === asked
            ? []
            : [
                {
                  code: 'brief_length',
                  severity: 'error',
                  message: retimed.includes(shot.id)
                    ? `The brief changed this shot's length since it was staged: it is ${frames} frames (${sec(frames)}) in the desk and ${asked} frames (${sec(asked)}) in the brief, at ${scene.fps} fps: Rideo refuses a clip of another length. Press Update shots (the brief's changes, above the scene), then send again.`
                    : `The shot is ${frames} frames (${sec(frames)}) in the desk and ${asked} frames (${sec(asked)}) in the brief, at ${scene.fps} fps: Rideo refuses a clip of another length. Set its length back, or change the shot's duration in Rideo.`,
                },
              ],
      };
    });
    const result = {
      type: 'result',
      id: `desk-${++results}`,
      sceneId: scene.id,
      fps: scene.fps,
      width: scene.width,
      height: scene.height,
      shots,
      files,
    };
    port.postMessage(
      result,
      files.map((f) => f.data),
    );
    if (part)
      port.postMessage({
        type: 'error',
        id: result.id,
        code: 'export_failed',
        message: `S${scene.shots.length} (${last.id}) was not rendered: the encoder stopped`,
      });
  };
  $('desk-send').addEventListener('click', () => send(false, false));
  $('desk-send-part').addEventListener('click', () => send(true, false));
  $('desk-send-longer').addEventListener('click', () => send(false, true));

  $('desk-done').addEventListener('click', () => {
    if (!scene) return;
    port.postMessage(stateOf());
    port.postMessage({ type: 'close', reason: 'done' });
  });

  $('desk-close-desk').addEventListener('click', () => {
    port?.postMessage({ type: 'close', reason: 'cancel' });
  });

  window.parent.postMessage({ protocol: '3d-desk', type: 'hello', versions: [1] }, '*');
})();
