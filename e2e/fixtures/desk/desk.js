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
//
// With `?units=1` it speaks library units (docs/design/director-desk.md#library-units): its `ready` announces them, and
// an open with `options.units` shows the brief's pins and the unit files it got (their bytes checked against their
// sha256), keeps a record per pinned slot (staged `unit` when the file came, or when the given state already held that
// version; `pending` `missing` else) inside its state's bytes, sends `units` with every state, and its Publish set,
// Publish new version and Publish prop send `unit-publish` with a real unit file; a linked `unit-ack` puts the
// published version in the record, as the real desk adopts it. What it saw is on `window.__desk` for the specs, and
// in either mode it lists every unit field an `open` carried (none for a desk from before units).
(() => {
  const $ = (id) => document.querySelector(`[data-testid="${id}"]`);
  const encode = (text) => new TextEncoder().encode(text).buffer;
  const decode = (buffer) => new TextDecoder().decode(buffer);
  const UNITS = new URLSearchParams(location.search).get('units') === '1';
  /** Library units on this open (`options.units` given), the brief's pins, the record per slot, what it saw. */
  let unitsOn = false;
  let pins = [];
  let records = {};
  let publishes = 0;
  const seen = { option: null, pins: [], files: [], acks: [], published: [], unitFields: [] };
  window.__desk = seen;
  const hex = async (data) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  /** A unit file as the 3D-Editor writes one: `3DUNIT\r\n`, container 1, the header's length at 12, its JSON at 16. */
  const unitFile = (kind, body) => {
    const json = new TextEncoder().encode(
      JSON.stringify({ format: '3d-editor.desk-unit', version: 1, kind }),
    );
    const text = new TextEncoder().encode(body);
    const out = new Uint8Array(16 + json.length + text.length);
    out.set(new TextEncoder().encode('3DUNIT\r\n'), 0);
    out[8] = 1;
    new DataView(out.buffer).setUint32(12, json.length, true);
    out.set(json, 16);
    out.set(text, 16 + json.length);
    return out.buffer;
  };
  /** The brief's pins in slot order: the set, the cast, the elements. */
  const pinsOf = (s) => [
    ...(s.set.unit ? [{ slot: 'set', kind: 'set', ...s.set.unit }] : []),
    ...s.cast.filter((c) => c.unit).map((c) => ({ slot: `cast:${c.id}`, kind: 'figure', ...c.unit })),
    ...s.elements.filter((e) => e.unit).map((e) => ({ slot: `el:${e.id}`, kind: 'prop', ...e.unit })),
  ];
  /** The state's rows: one per pinned slot of the record, in slot order. */
  const rows = () =>
    pins
      .map((p) => records[p.slot])
      .filter(Boolean)
      .map((r) => ({ ...r }));
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
    // with units, the record goes inside the state's bytes, as the real desk keeps it in the scene
    state: {
      format: '3d-editor.desk-state',
      version: 1,
      data: encode(unitsOn ? `${current}\n#units ${JSON.stringify(records)}` : current),
    },
    shots: scene.shots.length,
    ...(unitsOn ? { units: rows() } : {}),
  });
  const show = () => {
    $('desk-current').textContent = current;
    $('desk-retimed').textContent = retimed.join(', ');
    if (unitsOn)
      $('desk-records').textContent = rows()
        .map((r) => `${r.slot}=${r.ref}@${r.version}:${r.staged}${r.why ? `:${r.why}` : ''}`)
        .join(', ');
  };

  /** The pins of an open with units: what the files brought and what the given record held decide each slot. */
  const stageUnits = async (m, given) => {
    unitsOn = UNITS && !!m.options?.units;
    seen.option = m.options?.units ?? null;
    $('desk-units-option').textContent = JSON.stringify(seen.option ?? 'none');
    if (!unitsOn) return given;
    const [text, saved] = given?.includes('\n#units ') ? given.split('\n#units ') : [given, null];
    const before = saved ? JSON.parse(saved) : {};
    pins = pinsOf(m.scene);
    seen.pins = pins.map((p) => `${p.slot} ${p.ref}@${p.version}`);
    seen.files = [];
    for (const u of m.units ?? [])
      seen.files.push({
        ref: u.ref,
        version: u.version,
        bytes: u.unit.data.byteLength,
        ok: (await hex(u.unit.data)) === u.sha256,
        sha256: u.sha256,
      });
    records = {};
    for (const p of pins) {
      const file = seen.files.find(
        (f) => f.ref === p.ref && f.version === p.version && f.sha256 === p.sha256,
      );
      const held = before[p.slot];
      const staged =
        file?.ok || (held && held.staged === 'unit' && held.ref === p.ref && held.version === p.version);
      records[p.slot] = {
        slot: p.slot,
        ref: p.ref,
        version: p.version,
        sha256: p.sha256,
        staged: staged ? 'unit' : 'pending',
        local: false,
        ...(staged ? {} : { why: 'missing' }),
      };
    }
    $('desk-pins').replaceChildren(
      ...seen.pins.map((t) => {
        const li = document.createElement('li');
        li.dataset.testid = 'desk-pin';
        li.textContent = t;
        return li;
      }),
    );
    $('desk-unit-files').replaceChildren(
      ...seen.files.map((f) => {
        const li = document.createElement('li');
        li.dataset.testid = 'desk-unit-file';
        li.textContent = `${f.ref}@${f.version} ${f.bytes} bytes ${f.ok ? 'sha256 ok' : 'sha256 wrong'}`;
        return li;
      }),
    );
    return text;
  };

  let queue = Promise.resolve();
  const onPort = (event) => {
    queue = queue.then(() => handle(event.data)).catch((err) => console.error(err));
  };
  /** Every library-unit field an `open` carries, in either mode: a desk from before units must see none. */
  const unitFieldsOf = (m) => [
    ...(m.options && 'units' in m.options ? ['options.units'] : []),
    ...('units' in m ? ['units'] : []),
    ...(m.scene?.set && 'unit' in m.scene.set ? ['set.unit'] : []),
    ...(m.scene?.cast ?? []).filter((c) => 'unit' in c).map((c) => `cast.unit (${c.id})`),
    ...(m.scene?.elements ?? []).filter((e) => 'unit' in e).map((e) => `elements.unit (${e.id})`),
  ];
  const handle = async (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'open') {
      if (scene)
        return port.postMessage({ type: 'error', code: 'busy', message: 'The scene is open already.' });
      seen.unitFields = unitFieldsOf(m);
      $('desk-unit-fields').textContent = seen.unitFields.join(', ') || 'none';
      scene = m.scene;
      const given = UNITS
        ? await stageUnits(m, m.state ? decode(m.state.data) : null)
        : m.state
          ? decode(m.state.data)
          : null;
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
    } else if (m.type === 'unit-ack') {
      seen.acks.push(m);
      const sent = seen.published.find((p) => p.id === m.id);
      $('desk-unit-ack').textContent = m.ok
        ? `${m.id}: ${m.ref} v${m.version} ${m.linked ? 'linked' : `not linked (${m.message ?? ''})`}`
        : `${m.id}: refused ${m.code}: ${m.message ?? ''}`;
      // linked: the published objects become an instance of that version, and the record holds the pin
      if (m.ok && m.linked && sent && unitsOn) {
        records[sent.slot] = {
          slot: sent.slot,
          ref: m.ref,
          version: m.version,
          sha256: sent.sha256,
          staged: 'unit',
          local: false,
        };
        if (!pins.some((p) => p.slot === sent.slot))
          pins.push({
            slot: sent.slot,
            kind: sent.kind,
            ref: m.ref,
            version: m.version,
            sha256: sent.sha256,
          });
        current = `${current} +published${publishes}`;
        show();
        port.postMessage(stateOf());
      }
    }
  };

  /** A `unit-publish`: a real unit file of the kind, from the slot it came from; `version` makes it the set's next. */
  const publish = async (kind, from, slot, newVersionOf) => {
    if (!scene || !unitsOn) return;
    const n = ++publishes;
    const data = unitFile(kind, `${kind} of ${scene.id}, publish ${n}`);
    const sha256 = await hex(data);
    const id = `pub-${n}`;
    seen.published.push({ id, slot, kind, sha256 });
    port.postMessage(
      {
        type: 'unit-publish',
        id,
        kind,
        name: kind === 'set' ? 'Harbor set' : 'Brass lamp',
        description: `Published from ${scene.name}`,
        ...(newVersionOf ? { newVersionOf } : {}),
        from,
        unit: { format: '3d-editor.desk-unit', version: 1, data },
        sha256,
        thumbnail: null,
        meta: {
          dimensionsM: [12, 9, 4],
          objects: 3,
          triangles: 1200,
          actor: null,
          credits: [],
          deskVersion: '0.0.0-e2e',
          digest: sha256,
        },
      },
      [data],
    );
  };
  $('desk-publish-set').addEventListener('click', () =>
    publish('set', { castId: null, elementId: null, set: true }, 'set', null),
  );
  // the next version of the set the record holds
  $('desk-publish-version').addEventListener('click', () => {
    const held = records.set;
    if (held)
      publish('set', { castId: null, elementId: null, set: true }, 'set', {
        ref: held.ref,
        version: held.version,
      });
  });
  $('desk-publish-prop').addEventListener('click', () => {
    const prop = scene?.elements.find((e) => e.kind === 'prop');
    if (prop) publish('prop', { castId: null, elementId: prop.id, set: false }, `el:${prop.id}`, null);
  });

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
        ...(UNITS
          ? { units: { versions: [1], kinds: ['set', 'prop', 'figure'], maxBytes: 33554432, publish: true } }
          : {}),
      },
    });
  });
  if (UNITS) $('desk-units').hidden = false;

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
