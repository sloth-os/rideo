import { describe, expect, it } from 'vitest';
import { agentCommits, type CommitSummary, ProjectDigestSchema, projectDigest } from '../src';
import * as f from '../src/testing/fixtures';

/** What the project list and the Inbox show of a project (docs/design/storage-webdav.md#slow-and-flaky-servers). */

const commit = (id: string, kind: 'user' | 'agent', at: string): CommitSummary => ({
  id,
  parents: [],
  author: {
    kind,
    id: kind === 'agent' ? 'tok_0000000000aaaa' : 'usr_0000000000aaaa',
    name: kind === 'agent' ? 'Claude Code' : 'Sam',
  },
  message: `${kind} edit`,
  timestamp: at,
  changes: [],
});

describe('project summaries', () => {
  it('holds the card, who may see it, the gate, the open reviews and the agents’ commits', () => {
    const docs = f.docs();
    const review = {
      id: 'rev_0000000000aaaa',
      title: 'Check the pilot',
      target: { kind: 'project' },
      gate: null,
      link: null,
      decisions: [
        {
          author: { kind: 'user', id: 'usr_0000000000bbbb', name: 'Rosie' },
          verdict: 'approve',
          at: '2026-10-28T00:00:00.000Z',
        },
      ],
      required: 1,
      status: 'open',
      createdBy: { kind: 'user', id: 'usr_0000000000aaaa', name: 'Sam' },
      createdAt: '2026-10-28T00:00:00.000Z',
      gateApprovedAt: null,
    };
    docs.reviews = {
      [review.id]: review as never,
      other: { ...review, id: 'rev_0000000000cccc', status: 'closed' } as never,
    };
    const log = [
      commit('c3', 'agent', '2026-10-28T03:00:00.000Z'),
      commit('c2', 'user', '2026-10-28T02:00:00.000Z'),
      commit('c1', 'agent', '2026-10-28T01:00:00.000Z'),
    ];
    const d = projectDigest({
      projectId: docs.project.id,
      docs,
      branch: 'main',
      commit: 'c3',
      updatedAt: log[0]!.timestamp,
      agents: agentCommits(log),
    });
    expect(ProjectDigestSchema.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(d.summary).toMatchObject({
      id: docs.project.id,
      kind: docs.project.kind,
      title: docs.project.title,
      updatedAt: '2026-10-28T03:00:00.000Z',
    });
    expect(d.summary).not.toHaveProperty('role');
    expect(d).toMatchObject({ branch: 'main', commit: 'c3', access: docs.project.access });
    expect(d.gate).toMatchObject({ id: expect.any(String), satisfied: expect.any(Boolean), approved: false });
    expect(d.reviews).toEqual([
      {
        id: 'rev_0000000000aaaa',
        title: 'Check the pilot',
        createdById: 'usr_0000000000aaaa',
        createdBy: 'Sam',
        createdAt: '2026-10-28T00:00:00.000Z',
        gate: null,
        deciders: ['usr_0000000000bbbb'],
      },
    ]);
    expect(d.agents.map((a) => [a.id, a.agent])).toEqual([
      ['c3', 'Claude Code'],
      ['c1', 'Claude Code'],
    ]);
  });
});

describe('the studio library in a summary (docs/design/library.md#where-it-is-used)', () => {
  it('lists links and pins, and a summary written before the field still reads, as version 1', () => {
    const docs = f.docs();
    const mira = f.character();
    const by = { kind: 'user' as const, id: 'usr_0000000000aaaa', name: 'Sam' };
    docs.characters = {
      [mira.id]: {
        ...mira,
        library: {
          itemId: 'lib_0000000000mira00',
          version: 2,
          digest: 'd'.repeat(64),
          mode: 'used',
          at: '2026-11-20T00:00:00.000Z',
          by,
        },
        deskUnit: {
          kind: 'desk-figure',
          itemId: 'lib_0000000000fig000',
          version: 1,
          sha256: 'e'.repeat(64),
          name: 'Mira look',
          actorKind: null,
          heightM: null,
          pinnedAt: '2026-11-20T00:00:00.000Z',
          pinnedBy: by,
        },
      },
    };
    const d = projectDigest({ projectId: docs.project.id, docs, branch: 'main', commit: 'c1', agents: [] });
    expect(d.version).toBe(1);
    expect(d.library).toEqual([
      {
        itemId: 'lib_0000000000fig000',
        version: 1,
        via: 'deskUnit',
        entity: { kind: 'character', id: mira.id, name: mira.name },
      },
      {
        itemId: 'lib_0000000000mira00',
        version: 2,
        via: 'library',
        entity: { kind: 'character', id: mira.id, name: mira.name },
      },
    ]);
    const { library: _, ...before } = d;
    expect(ProjectDigestSchema.parse(JSON.parse(JSON.stringify(before))).library).toBeUndefined();
    expect(
      projectDigest({ projectId: docs.project.id, docs: f.docs(), branch: 'main', commit: 'c1', agents: [] })
        .library,
    ).toEqual([]);
  });
});
