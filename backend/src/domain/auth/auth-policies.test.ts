import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OTP_POLICY, canRequestNewOtp, evaluateOtpAttempt } from './otp-policy.ts';
import { validatePassword } from './password-policy.ts';
import { LOCKOUT_POLICY, afterFailedAttempt, afterSuccessfulLogin, isLocked, lockDurationMinutes } from './lockout-policy.ts';
import { decideRefresh, rotatedHashes, MAX_PREVIOUS_HASHES, type RefreshSessionState } from './refresh-rotation.ts';

const T0 = 1_800_000_000_000;

describe('OTP policy', () => {
  const fresh = { status: 'ISSUED' as const, issuedAtMs: T0, attempts: 0 };

  it('verifies a correct code inside the validity window', () => {
    const r = evaluateOtpAttempt(fresh, T0 + 60_000, true);
    assert.equal(r.outcome, 'VERIFIED');
    assert.equal(r.status, 'VERIFIED');
  });

  it('expires after 5 minutes even for a correct code', () => {
    const r = evaluateOtpAttempt(fresh, T0 + OTP_POLICY.ttlSeconds * 1000 + 1, true);
    assert.equal(r.outcome, 'EXPIRED');
    assert.equal(evaluateOtpAttempt(fresh, T0 + OTP_POLICY.ttlSeconds * 1000, true).outcome, 'VERIFIED');
  });

  it('counts wrong attempts and locks on the fifth', () => {
    let state = fresh;
    for (let i = 1; i < OTP_POLICY.maxAttempts; i += 1) {
      const r = evaluateOtpAttempt(state, T0 + 1000, false);
      assert.equal(r.outcome, 'INVALID');
      assert.equal(r.status, 'ISSUED');
      assert.equal(r.attemptsRemaining, OTP_POLICY.maxAttempts - i);
      state = { status: r.status, issuedAtMs: T0, attempts: r.attempts };
    }
    const last = evaluateOtpAttempt(state, T0 + 1000, false);
    assert.equal(last.outcome, 'INVALID');
    assert.equal(last.status, 'LOCKED');
    assert.equal(last.attemptsRemaining, 0);
  });

  it('a locked challenge rejects even the right code', () => {
    const r = evaluateOtpAttempt({ status: 'LOCKED', issuedAtMs: T0, attempts: 5 }, T0 + 1000, true);
    assert.equal(r.outcome, 'NOT_ACTIVE');
    const exhausted = evaluateOtpAttempt({ status: 'ISSUED', issuedAtMs: T0, attempts: 5 }, T0 + 1000, true);
    assert.equal(exhausted.outcome, 'LOCKED');
  });

  it('a used challenge cannot be replayed', () => {
    assert.equal(evaluateOtpAttempt({ status: 'VERIFIED', issuedAtMs: T0, attempts: 1 }, T0 + 1000, true).outcome, 'NOT_ACTIVE');
  });

  it('enforces the 60 second resend cooldown', () => {
    assert.deepEqual(canRequestNewOtp(null, T0), { allowed: true, retryAfterSeconds: 0 });
    assert.deepEqual(canRequestNewOtp(T0, T0 + 10_000), { allowed: false, retryAfterSeconds: 50 });
    assert.deepEqual(canRequestNewOtp(T0, T0 + 60_000), { allowed: true, retryAfterSeconds: 0 });
  });
});

describe('password policy', () => {
  it('accepts a long passphrase without composition rules', () => {
    assert.deepEqual(validatePassword('correct horse battery staple'), []);
  });

  it('flags short, long, low variety and sequential passwords', () => {
    assert.ok(validatePassword('abc123').includes('TOO_SHORT'));
    assert.ok(validatePassword('x'.repeat(129)).includes('TOO_LONG'));
    assert.ok(validatePassword('aaaaaaaaaaaa').includes('LOW_VARIETY'));
    assert.ok(validatePassword('aaaaaaaaaaaa').includes('SEQUENTIAL_OR_REPEATED'));
    assert.ok(validatePassword('1234567890').includes('SEQUENTIAL_OR_REPEATED'));
    assert.ok(validatePassword('abcdefghijkl').includes('SEQUENTIAL_OR_REPEATED'));
    assert.ok(validatePassword('0987654321').includes('SEQUENTIAL_OR_REPEATED'));
    assert.deepEqual(validatePassword('1234567890a'), []);
  });

  it('rejects passwords containing the user identifiers', () => {
    assert.ok(validatePassword('Mahmoud-Farm-2026!', { identifiers: ['mahmoud'] }).includes('CONTAINS_IDENTIFIER'));
    assert.deepEqual(validatePassword('correct horse battery staple', { identifiers: ['ab'] }), []);
  });

  it('uses the injected breached-password check', () => {
    assert.ok(validatePassword('correct horse battery staple', { isBreached: () => true }).includes('BREACHED'));
    assert.deepEqual(validatePassword('correct horse battery staple', { isBreached: () => false }), []);
  });

  it('counts characters, not UTF-16 units, so Arabic passphrases are measured fairly', () => {
    assert.deepEqual(validatePassword('كلمة سر طويلة جدا'), []);
    assert.ok(validatePassword('😀😁😂🤣').includes('TOO_SHORT'));
  });
});

describe('lockout policy', () => {
  it('does not lock before the threshold and escalates afterwards', () => {
    assert.equal(lockDurationMinutes(1), 0);
    assert.equal(lockDurationMinutes(LOCKOUT_POLICY.threshold - 1), 0);
    assert.equal(lockDurationMinutes(5), 15);
    assert.equal(lockDurationMinutes(9), 15);
    assert.equal(lockDurationMinutes(10), 30);
    assert.equal(lockDurationMinutes(15), 60);
    assert.equal(lockDurationMinutes(10_000), LOCKOUT_POLICY.maxMinutes);
  });

  it('locks on the fifth failure and clears on success', () => {
    let state = afterSuccessfulLogin();
    for (let i = 0; i < 4; i += 1) state = afterFailedAttempt(state, T0);
    assert.equal(isLocked(state, T0), false);
    state = afterFailedAttempt(state, T0);
    assert.equal(isLocked(state, T0 + 14 * 60_000), true);
    assert.equal(isLocked(state, T0 + 15 * 60_000), false);
    assert.deepEqual(afterSuccessfulLogin(), { failures: 0, lockedUntilMs: null });
  });
});

describe('refresh token rotation', () => {
  const session: RefreshSessionState = {
    status: 'ACTIVE',
    currentHash: 'hash-current',
    previousHashes: ['hash-old-1', 'hash-old-2'],
    expiresAtMs: T0 + 1000,
  };

  it('rotates when the current token is presented', () => {
    assert.deepEqual(decideRefresh(session, 'hash-current', T0), { action: 'ROTATE' });
  });

  it('flags reuse of a rotated token as compromise', () => {
    assert.deepEqual(decideRefresh(session, 'hash-old-2', T0), { action: 'COMPROMISED' });
  });

  it('rejects unknown tokens, missing sessions, expired and revoked sessions', () => {
    assert.deepEqual(decideRefresh(session, 'other', T0), { action: 'REJECT', reason: 'UNKNOWN' });
    assert.deepEqual(decideRefresh(null, 'hash-current', T0), { action: 'REJECT', reason: 'UNKNOWN' });
    assert.deepEqual(decideRefresh(session, 'hash-current', T0 + 1000), { action: 'REJECT', reason: 'EXPIRED' });
    for (const status of ['REVOKED', 'EXPIRED', 'COMPROMISED'] as const) {
      assert.deepEqual(decideRefresh({ ...session, status }, 'hash-current', T0), { action: 'REJECT', reason: 'REVOKED' });
    }
  });

  it('keeps a bounded history of retired hashes, newest first', () => {
    let hashes: string[] = [];
    for (let i = 0; i < MAX_PREVIOUS_HASHES + 5; i += 1) hashes = rotatedHashes(hashes, `h${i}`);
    assert.equal(hashes.length, MAX_PREVIOUS_HASHES);
    assert.equal(hashes[0], `h${MAX_PREVIOUS_HASHES + 4}`);
  });
});
