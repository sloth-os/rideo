import { createHash } from 'node:crypto';
import { type APIRequestContext, expect } from '@playwright/test';
import type { Api } from './api';

/**
 * Library units for the desk specs (docs/design/director-desk.md#library-units): unit files as the 3D-Editor writes
 * them, saved to the studio library and pinned on a project's entities through the API.
 */

export type DeskUnitKind = 'set' | 'prop' | 'figure';

/**
 * A 3D unit file (docs/design/library.md#the-three-hashes): `3DUNIT` CR LF, container version 1, codec 0, two zero
 * bytes, the JSON header's length at byte 12 (little-endian), the header at 16 (its format, version, kind and a name
 * of 1–120 characters), then the body.
 */
export function unitFile(kind: DeskUnitKind, body: string): Buffer {
  const header = Buffer.from(
    JSON.stringify({ format: '3d-editor.desk-unit', version: 1, kind, name: body.slice(0, 120) }),
  );
  const text = Buffer.from(body);
  const out = Buffer.alloc(16 + header.length + text.length);
  out.write('3DUNIT\r\n', 0, 'latin1');
  out[8] = 1;
  out.writeUInt32LE(header.length, 12);
  header.copy(out, 16);
  text.copy(out, 16 + header.length);
  return out;
}

export interface LibraryUnit {
  id: string;
  name: string;
  version: number;
  sha256: string;
  bytes: number;
}

/** A unit saved to the studio library as a new item (`POST /api/library/items`, docs/design/library.md#surfaces). */
export async function libraryUnit(
  request: APIRequestContext,
  kind: DeskUnitKind,
  name: string,
  actor: { kind: string; heightM: number } | null = null,
): Promise<LibraryUnit> {
  const data = unitFile(kind, `${name}, a unit of the e2e suite`);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const res = await request.post('/api/library/items', {
    multipart: {
      meta: JSON.stringify({
        kind: `desk-${kind}`,
        name,
        unit: {
          format: '3d-editor.desk-unit',
          formatVersion: 1,
          meta: {
            dimensionsM: [8, 6, 4],
            objects: 3,
            triangles: 1200,
            actor,
            credits: [],
            deskVersion: '0.0.0-e2e',
            digest: sha256,
          },
        },
      }),
      payload: { name: 'unit.bin', mimeType: 'application/octet-stream', buffer: data },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const out = (await res.json()) as { item: { id: string }; version: { version: number; digest: string } };
  expect(out.version.digest).toBe(sha256);
  return { id: out.item.id, name, version: out.version.version, sha256, bytes: data.length };
}

/** Pins a unit on a character or an element (an apply in mode `pin`, docs/design/library.md#pins-on-entities). */
export async function pinUnit(
  api: Api,
  projectId: string,
  unit: LibraryUnit,
  target: { kind: 'character' | 'element'; id: string },
): Promise<void> {
  await api.call('POST', `/projects/${projectId}/library/apply`, { itemId: unit.id, target });
}
