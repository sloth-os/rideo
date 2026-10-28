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
