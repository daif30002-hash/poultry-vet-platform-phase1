import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertReasonIfRequired, isReasonRequired } from './audit-policy.ts';
import { DomainError } from '../errors.ts';

describe('audit reason policy', () => {
  it('requires a reason for sensitive actions', () => {
    for (const reason of [undefined, null, '', '  ']) {
      assert.throws(() => assertReasonIfRequired('USER_ROLES_CHANGED', reason), (e: unknown) => e instanceof DomainError && e.code === 'REASON_REQUIRED');
    }
    assert.doesNotThrow(() => assertReasonIfRequired('USER_ROLES_CHANGED', 'promoted to warehouse lead'));
  });

  it('does not require one for ordinary actions', () => {
    assert.equal(isReasonRequired('AUTH_LOGIN_SUCCESS'), false);
    assert.doesNotThrow(() => assertReasonIfRequired('AUTH_LOGIN_SUCCESS', null));
  });
});
