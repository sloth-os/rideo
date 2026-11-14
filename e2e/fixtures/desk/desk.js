// A stand-in for the 3D-Editor's desk page (docs/design/director-desk.md#tests): the desk side of the embed protocol,
// version 1, from the contract's fixtures' shapes. It stages nothing: it shows the brief's shots and the state it was
// given, makes a state of its own text, and its Send posts a result for every shot (a real H.264 clip per mode and a
// PNG still, as bytes) whose frames, size and rate come from the brief.
(() => {
  const $ = (id) => document.querySelector(`[data-testid="${id}"]`);
  const encode = (text) => new TextEncoder().encode(text).buffer;
  const decode = (buffer) => new TextDecoder().decode(buffer);
  let port = null;
  let scene = null;
  let current = '';
  let edits = 0;
  let results = 0;
  const media = Promise.all(
    ['clip.mp4', 'still.png'].map((name) => fetch(name).then((r) => r.arrayBuffer())),
  );

  const stateOf = (id) => ({
    type: 'state',
    ...(id ? { id } : {}),
    sceneId: scene.id,
    state: { format: '3d-editor.desk-state', version: 1, data: encode(current) },
    shots: scene.shots.length,
  });
  const show = () => {
    $('desk-current').textContent = current;
  };

  const onPort = (event) => {
    const m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'open') {
      if (scene)
        return port.postMessage({ type: 'error', code: 'busy', message: 'The scene is open already.' });
      scene = m.scene;
      const given = m.state ? decode(m.state.data) : null;
      current = given ?? `staged ${scene.id}`;
      $('desk-connected').textContent = 'open';
      $('desk-scene').textContent = scene.name;
      $('desk-options').textContent = JSON.stringify(m.options ?? {});
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
        source: given ? 'state' : 'brief',
        changes: null,
      });
      port.postMessage(stateOf());
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

  $('desk-send').addEventListener('click', async () => {
    if (!scene) return;
    const [clip, still] = await media;
    const files = [];
    const shots = scene.shots.map((shot, i) => {
      const frames = Math.max(1, Math.round(shot.durationSec * scene.fps));
      const references = {};
      for (const mode of ['camera', 'motion', 'pose']) {
        references[mode] = `${shot.id}.${mode}.mp4`;
        files.push({ name: references[mode], mime: 'video/mp4', data: clip.slice(0) });
      }
      files.push({ name: `${shot.id}.still.png`, mime: 'image/png', data: still.slice(0) });
      return {
        shotId: shot.id,
        frames,
        durationSec: frames / scene.fps,
        references,
        still: `${shot.id}.still.png`,
        camera: { lensMm: 40, move: 'dolly_left' },
        line: 'Everyone stands where the brief puts them.',
        moves: null,
        // the last shot's camera disagrees with the planned layout
        planAgrees: i === scene.shots.length - 1 ? false : null,
        issues: [],
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
  });

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
