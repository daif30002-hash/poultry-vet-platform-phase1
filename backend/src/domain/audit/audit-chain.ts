import { createHash } from 'node:crypto';
import { DomainError } from '../errors.ts';

export const GENESIS_HASH = '0'.repeat(64);

export const ACTOR_TYPES = ['USER', 'SYSTEM', 'API_CLIENT'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface AuditEntry {
  readonly companyId: string;
  readonly seq: number;
  /** ISO 8601 UTC with milliseconds, exactly as produced by Date.toISOString() */
  readonly occurredAt: string;
  readonly clientOccurredAt: string | null;
  readonly branchId: string | null;
  readonly actorId: string | null;
  readonly actorType: ActorType;
  readonly sessionId: string | null;
  readonly ip: string | null;
  readonly device: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before: Json | null;
  readonly after: Json | null;
  readonly reason: string | null;
  readonly requestId: string | null;
}

export type UnsealedEntry = Omit<AuditEntry, 'seq'>;

export interface StoredAuditRecord extends AuditEntry {
  readonly prevHash: string;
  readonly rowHash: string;
}

export interface ChainHead {
  readonly seq: number;
  readonly hash: string;
}

export type VerifyFailure = 'SEQ_GAP' | 'PREV_HASH_MISMATCH' | 'ROW_HASH_MISMATCH';

export type VerifyResult =
  | { readonly ok: true; readonly checked: number; readonly head: ChainHead }
  | { readonly ok: false; readonly checked: number; readonly brokenAtSeq: number; readonly failure: VerifyFailure };

const ACTION_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(message: string): never {
  throw new DomainError('VALIDATION_FAILED', message);
}

/** Deterministic JSON: sorted keys, no whitespace, no undefined, no unsafe numbers. */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) return invalid('non-finite number in audit payload');
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) return invalid('unsafe integer in audit payload');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map((item) => canonicalize(item)).join(',') + ']';
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return invalid('only plain objects are allowed in audit payload');
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        if (record[key] === undefined) return invalid(`undefined value at key ${key}`);
        parts.push(JSON.stringify(key) + ':' + canonicalize(record[key]));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      return invalid(`unsupported ${typeof value} in audit payload`);
  }
}

function entryOf(record: AuditEntry): AuditEntry {
  return {
    companyId: record.companyId,
    seq: record.seq,
    occurredAt: record.occurredAt,
    clientOccurredAt: record.clientOccurredAt,
    branchId: record.branchId,
    actorId: record.actorId,
    actorType: record.actorType,
    sessionId: record.sessionId,
    ip: record.ip,
    device: record.device,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    before: record.before,
    after: record.after,
    reason: record.reason,
    requestId: record.requestId,
  };
}

export function computeRowHash(prevHash: string, entry: AuditEntry): string {
  return createHash('sha256').update(prevHash).update('\n').update(canonicalize(entryOf(entry))).digest('hex');
}

function assertIsoUtc(field: string, value: string): void {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    invalid(`${field} must be an ISO 8601 UTC timestamp with milliseconds`);
  }
}

export function validateEntry(entry: UnsealedEntry): void {
  if (!ACTION_PATTERN.test(entry.action)) invalid('action must be UPPER_SNAKE_CASE');
  if (entry.entityType.trim().length === 0) invalid('entityType is required');
  if (!ACTOR_TYPES.includes(entry.actorType)) invalid('unknown actorType');
  if (entry.actorType === 'USER' && entry.actorId === null) invalid('a USER actor needs actorId');
  for (const [field, value] of [
    ['companyId', entry.companyId],
    ['actorId', entry.actorId],
    ['branchId', entry.branchId],
    ['sessionId', entry.sessionId],
    ['entityId', entry.entityId],
  ] as const) {
    // lowercase canonical form only: the database returns uuids this way, so hashes stay verifiable
    if (value !== null && !UUID_PATTERN.test(value)) invalid(`${field} must be a lowercase canonical uuid`);
  }
  assertIsoUtc('occurredAt', entry.occurredAt);
  if (entry.clientOccurredAt !== null) assertIsoUtc('clientOccurredAt', entry.clientOccurredAt);
}

/** Links a new entry to the current head of the company chain. */
export function sealEntry(head: ChainHead | null, entry: UnsealedEntry): StoredAuditRecord {
  validateEntry(entry);
  if (head !== null && !HASH_PATTERN.test(head.hash)) invalid('malformed chain head hash');
  const prevHash = head === null ? GENESIS_HASH : head.hash;
  const seq = (head === null ? 0 : head.seq) + 1;
  const sealed: AuditEntry = { ...entry, seq };
  return { ...sealed, prevHash, rowHash: computeRowHash(prevHash, sealed) };
}

/**
 * Verifies a contiguous run of records. To verify a window that does not start at the beginning,
 * pass the head (seq and hash) of the record right before it.
 */
export function verifyChain(records: readonly StoredAuditRecord[], start: ChainHead | null = null): VerifyResult {
  let expectedSeq = (start === null ? 0 : start.seq) + 1;
  let prevHash = start === null ? GENESIS_HASH : start.hash;
  let checked = 0;
  for (const record of records) {
    if (record.seq !== expectedSeq) return { ok: false, checked, brokenAtSeq: record.seq, failure: 'SEQ_GAP' };
    if (record.prevHash !== prevHash) {
      return { ok: false, checked, brokenAtSeq: record.seq, failure: 'PREV_HASH_MISMATCH' };
    }
    if (computeRowHash(record.prevHash, record) !== record.rowHash) {
      return { ok: false, checked, brokenAtSeq: record.seq, failure: 'ROW_HASH_MISMATCH' };
    }
    prevHash = record.rowHash;
    expectedSeq += 1;
    checked += 1;
  }
  return { ok: true, checked, head: { seq: expectedSeq - 1, hash: prevHash } };
}

const REDACTED = '[REDACTED]';

/** Exact normalized key names (lowercase, letters and digits only) that are never written to the audit log. */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'otp',
  'otpcode',
  'codehash',
  'token',
  'accesstoken',
  'refreshtoken',
  'refreshhash',
  'idtoken',
  'tokenhash',
  'secret',
  'clientsecret',
  'secretciphertext',
  'secretref',
  'apikey',
  'authorization',
  'privatekey',
  'cardnumber',
  'cvv',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function redact(value: Json, extraKeys: readonly string[] = []): Json {
  const extra = new Set(extraKeys.map(normalizeKey));
  const walk = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: { [key: string]: Json } = {};
      for (const [key, child] of Object.entries(node)) {
        const normalized = normalizeKey(key);
        out[key] = SENSITIVE_KEYS.has(normalized) || extra.has(normalized) ? REDACTED : walk(child);
      }
      return out;
    }
    return node;
  };
  return walk(value);
}
