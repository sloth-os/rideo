import { describe, expect, it } from 'vitest';
import { deskPreconditionHolds } from '../../src/domain/desk';

/**
 * A desk state write names the state it replaces (docs/design/director-desk.md#when-rideo-stores-it): `If-Match` with
 * its ETag, or `If-None-Match: *` for none stored, evaluated as RFC 9110 does.
 */
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('deskPreconditionHolds', () => {
  it('holds without a precondition, whatever is stored', () => {
    expect(deskPreconditionHolds(null, undefined, undefined)).toBe(true);
    expect(deskPreconditionHolds(A, undefined, undefined)).toBe(true);
    // an empty header names nothing
    expect(deskPreconditionHolds(A, '', ' ')).toBe(true);
  });

  it('If-Match holds for the stored state only (strong comparison), and * for any stored state', () => {
    expect(deskPreconditionHolds(A, `"${A}"`, undefined)).toBe(true);
    expect(deskPreconditionHolds(A, `"${B}"`, undefined)).toBe(false);
    expect(deskPreconditionHolds(A, `"${B}", "${A}"`, undefined)).toBe(true);
    // a weak tag never matches If-Match
    expect(deskPreconditionHolds(A, `W/"${A}"`, undefined)).toBe(false);
    // an ETag without its quotes is read as the same tag
    expect(deskPreconditionHolds(A, A, undefined)).toBe(true);
    expect(deskPreconditionHolds(A, '*', undefined)).toBe(true);
    // nothing stored: no tag matches, not even *
    expect(deskPreconditionHolds(null, `"${A}"`, undefined)).toBe(false);
    expect(deskPreconditionHolds(null, '*', undefined)).toBe(false);
  });

  it('If-None-Match: * holds only while none is stored; a listed tag fails when it is the stored one', () => {
    expect(deskPreconditionHolds(null, undefined, '*')).toBe(true);
    expect(deskPreconditionHolds(A, undefined, '*')).toBe(false);
    expect(deskPreconditionHolds(A, undefined, `"${B}"`)).toBe(true);
    expect(deskPreconditionHolds(A, undefined, `W/"${A}"`)).toBe(false);
  });

  it('evaluates If-Match before If-None-Match: both must hold', () => {
    expect(deskPreconditionHolds(A, `"${A}"`, `"${B}"`)).toBe(true);
    expect(deskPreconditionHolds(A, `"${A}"`, '*')).toBe(false);
    expect(deskPreconditionHolds(A, `"${B}"`, `"${B}"`)).toBe(false);
  });
});
