import { describe, it, expect } from 'vitest';

import { canAccessCandidates } from '../src/lib/access';

describe('canAccessCandidates', () => {
  it('ADMIN always may (even with the flag false)', () => {
    expect(canAccessCandidates({ role: 'ADMIN', candidatesEnabled: false })).toBe(true);
    expect(canAccessCandidates({ role: 'ADMIN' })).toBe(true);
  });
  it('CUSTOMER with the flag true may', () => {
    expect(canAccessCandidates({ role: 'CUSTOMER', candidatesEnabled: true })).toBe(true);
  });
  it('CUSTOMER with the flag false may NOT (new signups)', () => {
    expect(canAccessCandidates({ role: 'CUSTOMER', candidatesEnabled: false })).toBe(false);
  });
  it('legacy session (flag undefined) is grandfathered → may', () => {
    expect(canAccessCandidates({ role: 'CUSTOMER' })).toBe(true);
  });
});
