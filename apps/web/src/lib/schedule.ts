// Local wall time -> UTC using the shared domain rules (DST gaps rejected,
// overlaps require an explicit earlier/later choice). Display only: the
// Worker re-validates every instant.
import { resolveLocalTime, ScheduleError, type ResolvedTime } from '@ayonix/domain';

export type ResolveResult =
  | { kind: 'empty' }
  | { kind: 'ok'; time: ResolvedTime }
  | { kind: 'ambiguous'; options: ResolvedTime[]; message: string }
  | { kind: 'error'; message: string };

export function resolveSchedule(date: string, time: string, timezone: string, occurrence?: 'earlier' | 'later'): ResolveResult {
  if (!date || !time) return { kind: 'empty' };
  try {
    return { kind: 'ok', time: resolveLocalTime(`${date}T${time}`, timezone, occurrence) };
  } catch (e) {
    if (e instanceof ScheduleError) {
      if (e.code === 'ambiguous_local_time') return { kind: 'ambiguous', options: e.options ?? [], message: e.message };
      return { kind: 'error', message: e.message };
    }
    return { kind: 'error', message: 'Enter a valid date and time.' };
  }
}

/** Earliest time the Worker accepts (it needs a couple of minutes of lead time). */
export const MIN_LEAD_MS = 3 * 60_000;

export function splitLocal(local: string | null | undefined): { date: string; time: string } {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(local ?? '');
  return m ? { date: m[1]!, time: m[2]! } : { date: '', time: '' };
}
