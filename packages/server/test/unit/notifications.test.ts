import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@rideo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotificationService } from '../../src/auth/notifications';
import { LiveHub, type LiveSocket } from '../../src/live/hub';

class FakeSocket implements LiveSocket {
  readyState = 1;
  sent: ServerMessage[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  on() {}
}

const n = (title: string) => ({
  kind: 'mention' as const,
  projectId: 'prj_000000000001',
  title,
  body: '',
  link: '/p/x',
});

describe('notifications (docs/design/review.md#notifications)', () => {
  let dir: string;
  let hub: LiveHub;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rideo-ntf-'));
    hub = new LiveHub();
  });
  afterEach(async () => {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps them per person, newest first, pushes them to that person’s tabs and skips who did it', async () => {
    const mine = new FakeSocket();
    const theirs = new FakeSocket();
    hub.attach(mine, undefined, { userId: 'usr_0000000000aa' });
    hub.attach(theirs, undefined, { userId: 'usr_0000000000bb' });
    const svc = new NotificationService(dir, hub);
    await svc.init();
    await svc.notify(['usr_0000000000aa', 'usr_0000000000bb', 'usr_0000000000aa'], n('first'), {
      except: 'usr_0000000000bb',
    });
    await svc.notify(['usr_0000000000aa'], n('second'));
    const list = await svc.list('usr_0000000000aa');
    expect(list.unread).toBe(2);
    expect(list.notifications.map((x) => x.title)).toEqual(['second', 'first']);
    expect(list.notifications[0]).toMatchObject({ id: expect.stringMatching(/^ntf_/), read: false });
    expect((await svc.list('usr_0000000000bb')).notifications).toEqual([]);
    const pushed = mine.sent.filter((m) => m.type === 'notification');
    expect(pushed.map((m) => (m as { notification: { title: string } }).notification.title)).toEqual([
      'first',
      'second',
    ]);
    expect(theirs.sent.filter((m) => m.type === 'notification')).toEqual([]);

    // read marks, and what survives a restart
    expect(await svc.markRead('usr_0000000000aa', [list.notifications[1]!.id])).toEqual({ unread: 1 });
    const again = new NotificationService(dir, hub);
    const reloaded = await again.list('usr_0000000000aa');
    expect(reloaded.unread).toBe(1);
    expect(reloaded.notifications.map((x) => [x.title, x.read])).toEqual([
      ['second', false],
      ['first', true],
    ]);
    expect(await again.markRead('usr_0000000000aa')).toEqual({ unread: 0 });
    expect(JSON.parse(await readFile(join(dir, 'usr_0000000000aa.json'), 'utf8'))).toHaveLength(2);
  });

  it('keeps the last 500', async () => {
    const svc = new NotificationService(dir, hub);
    await svc.init();
    for (let i = 0; i < 505; i++) await svc.notify(['usr_0000000000aa'], n(`n${i}`));
    const all = await svc.list('usr_0000000000aa', 1000);
    expect(all.notifications).toHaveLength(500);
    expect(all.notifications[0]!.title).toBe('n504');
    expect(all.notifications.at(-1)!.title).toBe('n5');
  });
});
