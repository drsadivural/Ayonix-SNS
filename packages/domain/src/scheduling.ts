import type { TargetState } from '@ayonix/contracts';

export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_time' | 'past_time' | 'nonexistent_local_time' | 'ambiguous_local_time' | 'invalid_timezone' = 'invalid_time',
    readonly options?: ResolvedTime[],
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

// ---------------------------------------------------------------------------
// Publication state machine (docs/07-API-AND-DATA.md). Only explicit allowed
// transitions; the Worker additionally compare-and-swaps on target.version.

export const TRANSITIONS: Record<TargetState, readonly TargetState[]> = {
  draft: ['awaiting_approval', 'scheduled', 'canceled'],
  awaiting_approval: ['scheduled', 'draft', 'canceled'],
  scheduled: ['queued', 'canceled', 'awaiting_approval', 'reconnect_required'],
  queued: ['submitting', 'canceled', 'reconnect_required', 'scheduled'],
  submitting: ['processing', 'published', 'retry_wait', 'failed', 'outcome_unknown', 'reconnect_required'],
  processing: ['published', 'failed', 'outcome_unknown', 'reconnect_required'],
  retry_wait: ['queued', 'canceled', 'reconnect_required'],
  reconnect_required: ['awaiting_approval', 'scheduled', 'canceled', 'outcome_unknown'],
  outcome_unknown: ['published', 'failed'],
  published: [],
  failed: [],
  canceled: [],
};

export function canTransition(current: TargetState, next: TargetState): boolean {
  return Object.hasOwn(TRANSITIONS, current) && TRANSITIONS[current].includes(next);
}

export function transition(current: string, next: string): TargetState {
  if (!Object.hasOwn(TRANSITIONS, current) || !TRANSITIONS[current as TargetState].includes(next as TargetState)) {
    throw new RangeError(`Illegal transition ${current} -> ${next}`);
  }
  return next as TargetState;
}

export const TERMINAL_STATES: readonly TargetState[] = ['published', 'failed', 'canceled'];
/** States in which the provider may already hold the content. */
export const SUBMITTED_STATES: readonly TargetState[] = ['submitting', 'processing', 'outcome_unknown'];
/** States that can be canceled with a safe quota release. */
export const SAFE_CANCEL_STATES: readonly TargetState[] = ['draft', 'awaiting_approval', 'scheduled', 'queued', 'retry_wait', 'reconnect_required'];

/** Bounded backoff schedule (docs/02-ARCHITECTURE.md): 5s, 30s, 2m, 10m, 30m then dead letter. */
export const RETRY_DELAYS_SECONDS = [5, 30, 120, 600, 1800] as const;

export function retryDelaySeconds(attempt: number, retryAfterSeconds?: number | null, random = Math.random): number | null {
  if (attempt < 1 || attempt > RETRY_DELAYS_SECONDS.length) return null;
  const base = RETRY_DELAYS_SECONDS[attempt - 1]!;
  const jitter = Math.floor(base * 0.2 * random());
  return Math.max(base + jitter, retryAfterSeconds ?? 0);
}

// ---------------------------------------------------------------------------
// Time handling. Stored: IANA zone, original local wall time, chosen offset
// and UTC instant. Nonexistent DST times are rejected; ambiguous ones require
// an explicit occurrence choice.

const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function assertTimezone(timezone: unknown): string {
  if (typeof timezone !== 'string' || !timezone) throw new ScheduleError('IANA timezone required', 'invalid_timezone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    throw new ScheduleError(`Unknown timezone: ${timezone}`, 'invalid_timezone');
  }
  return timezone;
}

/** Validates an explicit future UTC timestamp (ported reference rule). */
export function validateSchedule({ utc, timezone }: { utc: unknown; timezone: unknown }, now = new Date()) {
  if (typeof utc !== 'string' || !UTC_RE.test(utc)) throw new ScheduleError('An explicit UTC timestamp is required');
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now.getTime())) throw new ScheduleError('Invalid date');
  if (date.toISOString().replace('.000Z', 'Z') !== utc.replace('.000Z', 'Z')) throw new ScheduleError('Invalid calendar timestamp');
  assertTimezone(timezone);
  if (date <= now) throw new ScheduleError('Schedule must be in the future', 'past_time');
  return { utc: date.toISOString(), timezone: timezone as string };
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let f = partsCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(timezone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a zone. */
export function wallClock(epochMs: number, timezone: string) {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(epochMs).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Zone offset in minutes (local - UTC) at an instant. */
export function offsetMinutes(epochMs: number, timezone: string): number {
  const w = wallClock(epochMs, timezone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60000);
}

export function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export interface ResolvedTime {
  utc: string;
  local: string;
  offset: string;
  timezone: string;
}

/**
 * Convert a local wall time ("YYYY-MM-DDTHH:mm") in an IANA zone to UTC.
 * Throws nonexistent_local_time for times skipped by a DST jump, and
 * ambiguous_local_time (with both options) unless `occurrence` selects one.
 */
export function resolveLocalTime(local: string, timezone: string, occurrence?: 'earlier' | 'later'): ResolvedTime {
  assertTimezone(timezone);
  const m = LOCAL_RE.exec(local);
  if (!m) throw new ScheduleError('Local time must look like YYYY-MM-DDTHH:mm');
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw new ScheduleError('Invalid calendar date');
  }
  const candidateOffsets = new Set<number>();
  for (const probe of [-48, -24, -12, 0, 12, 24, 48]) candidateOffsets.add(offsetMinutes(naive + probe * 3600_000, timezone));
  const matches: ResolvedTime[] = [];
  for (const off of [...candidateOffsets].sort((a, b) => b - a)) {
    const instant = naive - off * 60_000;
    const w = wallClock(instant, timezone);
    if (w.year === y && w.month === mo && w.day === d && w.hour === h && w.minute === mi && w.second === s && offsetMinutes(instant, timezone) === off) {
      if (!matches.some((x) => x.utc === new Date(instant).toISOString())) {
        matches.push({ utc: new Date(instant).toISOString(), local: toLocalString(instant, timezone), offset: formatOffset(off), timezone });
      }
    }
  }
  matches.sort((a, b) => a.utc.localeCompare(b.utc));
  if (matches.length === 0) {
    throw new ScheduleError(`${local} does not exist in ${timezone} because of a daylight-saving change. Choose another time.`, 'nonexistent_local_time');
  }
  if (matches.length > 1) {
    if (occurrence === 'earlier') return matches[0]!;
    if (occurrence === 'later') return matches[matches.length - 1]!;
    throw new ScheduleError(`${local} happens twice in ${timezone}. Choose the earlier or later occurrence.`, 'ambiguous_local_time', matches);
  }
  return matches[0]!;
}

export function toLocalString(epochMs: number, timezone: string): string {
  const w = wallClock(epochMs, timezone);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}`;
}

/** Describe a UTC instant in a zone for confirmation displays. */
export function describeInstant(utc: string, timezone: string): ResolvedTime {
  assertTimezone(timezone);
  const ms = new Date(utc).getTime();
  if (!Number.isFinite(ms)) throw new ScheduleError('Invalid date');
  return { utc: new Date(ms).toISOString(), local: toLocalString(ms, timezone), offset: formatOffset(offsetMinutes(ms, timezone)), timezone };
}
