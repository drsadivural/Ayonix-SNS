import { describe, expect, it } from 'vitest';
import { formatLocalAndUtc } from './format';
import { resolveSchedule } from './schedule';

describe('local schedule time', () => {
  it('shows local wall time with the UTC instant', () => {
    expect(formatLocalAndUtc('2026-11-02T22:00:00.000Z', 'Australia/Melbourne')).toBe('03 Nov 2026 09:00 (02 Nov 22:00 UTC)');
  });

  it('converts a Melbourne wall time to UTC', () => {
    const r = resolveSchedule('2026-11-03', '09:00', 'Australia/Melbourne');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.time.utc).toBe('2026-11-02T22:00:00.000Z');
  });

  it('rejects a time skipped by daylight saving', () => {
    const r = resolveSchedule('2026-10-04', '02:30', 'Australia/Melbourne');
    expect(r.kind).toBe('error');
  });

  it('asks for earlier/later when a time happens twice', () => {
    const r = resolveSchedule('2026-04-05', '02:30', 'Australia/Melbourne');
    expect(r.kind).toBe('ambiguous');
    const later = resolveSchedule('2026-04-05', '02:30', 'Australia/Melbourne', 'later');
    expect(later.kind).toBe('ok');
  });
});
