import { DomainError } from '../errors.ts';

/** Actions for which a written reason is mandatory. Each module extends this list when it is built. */
export const REASON_REQUIRED_ACTIONS: ReadonlySet<string> = new Set([
  'COMPANY_SUSPENDED',
  'COMPANY_REACTIVATED',
  'COMPANY_ARCHIVED',
  'BRANCH_DEACTIVATED',
  'POLICY_CHANGED',
  'USER_SUSPENDED',
  'USER_REACTIVATED',
  'USER_DEACTIVATED',
  'USER_BLOCKED',
  'USER_UNBLOCKED',
  'USER_ROLES_CHANGED',
  'ROLE_PERMISSIONS_CHANGED',
  'ROLE_DELETED',
  'LICENSE_REJECTED',
  'DATA_HARD_DELETED',
]);

export function isReasonRequired(action: string): boolean {
  return REASON_REQUIRED_ACTIONS.has(action);
}

export function assertReasonIfRequired(action: string, reason: string | null | undefined): void {
  if (isReasonRequired(action) && (reason ?? '').trim().length === 0) {
    throw new DomainError('REASON_REQUIRED', `${action} requires a reason`, { action });
  }
}
