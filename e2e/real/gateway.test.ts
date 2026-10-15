import { describe, expect, it } from 'vitest';
import { redactKeys } from './gateway';

describe('the gateway log CI keeps', () => {
  it('holds no form of the keys: whole, or masked to their first and last four characters', () => {
    const key = 'sk-live-0123456789abcdef';
    const log = [
      `{"event": "backend_request", "authorization": "Bearer sk-l...cdef"}`,
      `curl -H 'authorization: Bearer ${key}'`,
      'x-goog-api-key: AIza...9xYz',
      'a key too short to mask: abc',
    ].join('\n');
    const out = redactKeys(log, [key, 'AIzaSyD-0000000009xYz', undefined, 'abc']);
    expect(out).toBe(
      [
        `{"event": "backend_request", "authorization": "Bearer ***"}`,
        `curl -H 'authorization: Bearer ***'`,
        'x-goog-api-key: ***',
        'a key too short to mask: abc',
      ].join('\n'),
    );
  });
});
