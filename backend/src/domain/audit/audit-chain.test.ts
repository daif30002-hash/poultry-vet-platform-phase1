import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENESIS_HASH,
  canonicalize,
  computeRowHash,
  redact,
  sealEntry,
  verifyChain,
  type ChainHead,
  type StoredAuditRecord,
  type UnsealedEntry,
} from './audit-chain.ts';
import { DomainError } from '../errors.ts';

const COMPANY = '00000000-0000-4000-8000-00000000000a';
const USER = '00000000-0000-4000-8000-0000000000e1';

function entry(n: number, overrides: Partial<UnsealedEntry> = {}): UnsealedEntry {
  return {
    companyId: COMPANY,
    occurredAt: new Date(Date.UTC(2026, 8, 21, 10, 0, n)).toISOString(),
    clientOccurredAt: null,
    branchId: null,
    actorId: USER,
    actorType: 'USER',
    sessionId: null,
    ip: null,
    device: null,
    action: 'ROLE_PERMISSIONS_CHANGED',
    entityType: 'role',
    entityId: '00000000-0000-4000-8000-0000000000f1',
    before: { permissions: ['A'] },
    after: { permissions: ['A', 'B'] },
    reason: 'quarterly review',
    requestId: `req-${n}`,
    ...overrides,
  };
}

function buildChain(length: number): StoredAuditRecord[] {
  const records: StoredAuditRecord[] = [];
  let head: ChainHead | null = null;
  for (let i = 1; i <= length; i += 1) {
    const sealed = sealEntry(head, entry(i));
    records.push(sealed);
    head = { seq: sealed.seq, hash: sealed.rowHash };
  }
  return records;
}

describe('canonicalize', () => {
  it('is independent of key order and whitespace', () => {
    assert.equal(canonicalize({ b: 1, a: { d: [1, 2], c: null } }), canonicalize({ a: { c: null, d: [1, 2] }, b: 1 }));
    assert.equal(canonicalize({ b: 1, a: 'x' }), '{"a":"x","b":1}');
  });

  it('rejects values that cannot round trip through JSON', () => {
    assert.throws(() => canonicalize({ a: undefined }), DomainError);
    assert.throws(() => canonicalize({ a: Number.NaN }), DomainError);
    assert.throws(() => canonicalize({ a: 2 ** 60 }), DomainError);
    assert.throws(() => canonicalize({ a: new Date() }), DomainError);
    assert.throws(() => canonicalize({ a: () => 1 }), DomainError);
  });
});

describe('hash chain', () => {
  it('starts at the genesis hash with seq 1', () => {
    const first = buildChain(1)[0] as StoredAuditRecord;
    assert.equal(first.seq, 1);
    assert.equal(first.prevHash, GENESIS_HASH);
    assert.match(first.rowHash, /^[0-9a-f]{64}$/);
    assert.equal(first.rowHash, computeRowHash(GENESIS_HASH, first));
  });

  it('a well formed chain verifies and reports its head', () => {
    const chain = buildChain(5);
    const result = verifyChain(chain);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.checked, 5);
      assert.equal(result.head.seq, 5);
      assert.equal(result.head.hash, (chain[4] as StoredAuditRecord).rowHash);
    }
  });

  it('an empty run verifies', () => {
    assert.equal(verifyChain([]).ok, true);
  });

  it('a window verifies when given the head before it', () => {
    const chain = buildChain(6);
    const before = chain[2] as StoredAuditRecord;
    assert.equal(verifyChain(chain.slice(3), { seq: before.seq, hash: before.rowHash }).ok, true);
    assert.equal(verifyChain(chain.slice(3)).ok, false);
  });

  it('detects an edited payload', () => {
    const chain = buildChain(4);
    const tampered = { ...(chain[2] as StoredAuditRecord), after: { permissions: [] as string[] } };
    const result = verifyChain([chain[0], chain[1], tampered, chain[3]] as StoredAuditRecord[]);
    assert.deepEqual(result.ok ? null : { at: result.brokenAtSeq, why: result.failure }, { at: 3, why: 'ROW_HASH_MISMATCH' });
  });

  it('detects an edited reason and an edited actor', () => {
    const chain = buildChain(2);
    assert.equal(verifyChain([chain[0], { ...(chain[1] as StoredAuditRecord), reason: 'other' }] as StoredAuditRecord[]).ok, false);
    assert.equal(verifyChain([{ ...(chain[0] as StoredAuditRecord), actorId: null }, chain[1]] as StoredAuditRecord[]).ok, false);
  });

  it('detects a deleted record', () => {
    const chain = buildChain(4);
    const result = verifyChain([chain[0], chain[2], chain[3]] as StoredAuditRecord[]);
    assert.deepEqual(result.ok ? null : { at: result.brokenAtSeq, why: result.failure }, { at: 3, why: 'SEQ_GAP' });
  });

  it('detects a swapped pair', () => {
    const chain = buildChain(3);
    assert.equal(verifyChain([chain[0], chain[2], chain[1]] as StoredAuditRecord[]).ok, false);
  });

  it('detects a record relinked with a forged previous hash even if its own hash is recomputed', () => {
    const chain = buildChain(3);
    const forgedPrev = 'f'.repeat(64);
    const second = chain[1] as StoredAuditRecord;
    const forged: StoredAuditRecord = { ...second, prevHash: forgedPrev, rowHash: computeRowHash(forgedPrev, second) };
    const result = verifyChain([chain[0], forged, chain[2]] as StoredAuditRecord[]);
    assert.deepEqual(result.ok ? null : { at: result.brokenAtSeq, why: result.failure }, { at: 2, why: 'PREV_HASH_MISMATCH' });
  });
});

describe('sealEntry validation', () => {
  it('rejects malformed actions, missing user actor and non normalized timestamps', () => {
    assert.throws(() => sealEntry(null, entry(1, { action: 'lower_case' })), DomainError);
    assert.throws(() => sealEntry(null, entry(1, { actorId: null })), DomainError);
    assert.throws(() => sealEntry(null, entry(1, { occurredAt: '2026-09-21 10:00:00' })), DomainError);
    assert.throws(() => sealEntry(null, entry(1, { entityType: '  ' })), DomainError);
    assert.throws(() => sealEntry(null, entry(1, { entityId: '00000000-0000-4000-8000-0000000000F1' })), DomainError);
    assert.throws(() => sealEntry(null, entry(1, { branchId: 'not-a-uuid' })), DomainError);
  });

  it('accepts system actors without an actor id', () => {
    assert.doesNotThrow(() => sealEntry(null, entry(1, { actorType: 'SYSTEM', actorId: null })));
  });

  it('refuses a malformed head hash', () => {
    assert.throws(() => sealEntry({ seq: 1, hash: 'nope' }, entry(2)), DomainError);
  });
});

describe('redact', () => {
  it('replaces secrets at any depth and leaves the rest', () => {
    const out = redact({
      email: 'a@b.co',
      password: 'hunter2',
      nested: { refresh_token: 'abc', list: [{ otpCode: '123456', keep: 1 }] },
      'api-key': 'k',
    });
    assert.deepEqual(out, {
      email: 'a@b.co',
      password: '[REDACTED]',
      nested: { refresh_token: '[REDACTED]', list: [{ otpCode: '[REDACTED]', keep: 1 }] },
      'api-key': '[REDACTED]',
    });
  });

  it('supports extra keys and does not mutate the input', () => {
    const input = { nationalId: '123', name: 'x' };
    assert.deepEqual(redact(input, ['national_id']), { nationalId: '[REDACTED]', name: 'x' });
    assert.equal(input.nationalId, '123');
  });
});
