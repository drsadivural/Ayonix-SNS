// Pure quota arithmetic. The Worker enforces the same invariants atomically in
// D1 (CHECK used+reserved<=allowance inside a single batch transaction); these
// helpers are the tested business-rule seed and are used for previews.

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaError';
  }
}

export interface QuotaCounters {
  allowance: number;
  used: number;
  reserved: number;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new QuotaError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function check(q: QuotaCounters) {
  integer(q.allowance, 'allowance');
  integer(q.used, 'used');
  integer(q.reserved, 'reserved');
  if (q.used + q.reserved > q.allowance) throw new QuotaError('Invalid quota state');
}

export function available(q: QuotaCounters): number {
  check(q);
  return q.allowance - q.used - q.reserved;
}

export function reserveQuota(q: QuotaCounters, targets: unknown): QuotaCounters {
  check(q);
  const n = integer(targets, 'targets', 1);
  if (n > q.allowance - q.used - q.reserved) throw new QuotaError('Quota exceeded');
  return { allowance: q.allowance, used: q.used, reserved: q.reserved + n };
}

export type Settlement = 'published' | 'definite_failure' | 'canceled_before_submission' | 'unknown';

export function settleReservation(q: QuotaCounters, outcome: Settlement): QuotaCounters {
  check(q);
  if (q.reserved < 1) throw new QuotaError('No valid reservation');
  switch (outcome) {
    case 'unknown':
      return { ...q };
    case 'published':
      return { allowance: q.allowance, used: q.used + 1, reserved: q.reserved - 1 };
    case 'definite_failure':
    case 'canceled_before_submission':
      return { allowance: q.allowance, used: q.used, reserved: q.reserved - 1 };
    default:
      throw new QuotaError('Unsupported settlement');
  }
}

/**
 * Upgrade inside a cycle grants only the allowance difference; used/reserved
 * are never reset. Downgrades take effect at next renewal, so the current
 * cycle's allowance never shrinks below what is already committed.
 */
export function upgradeAllowance(q: QuotaCounters, newCycleCap: number): QuotaCounters {
  check(q);
  integer(newCycleCap, 'newCycleCap');
  return { ...q, allowance: Math.max(q.allowance, newCycleCap) };
}
