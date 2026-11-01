// Ported from handoff/tests/domain.test.mjs plus DST coverage the reference lacked.
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  describeInstant,
  destinationProblems,
  reserveQuota,
  resolveLocalTime,
  retryDelaySeconds,
  ScheduleError,
  settleReservation,
  transition,
  upgradeAllowance,
  validateSchedule,
  validateTargets,
} from '../src/index.js';

describe('quota rules', () => {
  it('reserves entire multi-target cost or rejects', () => {
    const q = { allowance: 20, used: 15, reserved: 3 };
    expect(reserveQuota(q, 2)).toEqual({ allowance: 20, used: 15, reserved: 5 });
    expect(() => reserveQuota(q, 3)).toThrow();
    expect(q).toEqual({ allowance: 20, used: 15, reserved: 3 });
  });
  it('rejects bad quota counters and target counts', () => {
    for (const count of [0, -1, 1.1, '1', NaN]) expect(() => reserveQuota({ allowance: 20, used: 0, reserved: 0 }, count)).toThrow();
    expect(() => reserveQuota({ allowance: 20, used: 20, reserved: 1 }, 1)).toThrow();
  });
  it('published commits; definite failures release; unknown retains', () => {
    const q = { allowance: 20, used: 2, reserved: 3 };
    expect(settleReservation(q, 'published')).toEqual({ allowance: 20, used: 3, reserved: 2 });
    expect(settleReservation(q, 'definite_failure')).toEqual({ allowance: 20, used: 2, reserved: 2 });
    expect(settleReservation(q, 'unknown')).toEqual(q);
    expect(() => settleReservation({ ...q, reserved: 0 }, 'published')).toThrow();
  });
  it('upgrade grants only the difference and never resets usage', () => {
    expect(upgradeAllowance({ allowance: 20, used: 18, reserved: 2 }, 60)).toEqual({ allowance: 60, used: 18, reserved: 2 });
    expect(upgradeAllowance({ allowance: 60, used: 30, reserved: 0 }, 20)).toEqual({ allowance: 60, used: 30, reserved: 0 });
  });
});

describe('state machine', () => {
  it('terminal and unknown publication states cannot be blindly replayed', () => {
    expect(transition('submitting', 'outcome_unknown')).toBe('outcome_unknown');
    expect(() => transition('outcome_unknown', 'queued')).toThrow();
    expect(() => transition('outcome_unknown', 'canceled')).toThrow();
    expect(() => transition('published', 'queued')).toThrow();
    expect(() => transition('draft', 'published')).toThrow();
    expect(transition('outcome_unknown', 'published')).toBe('published');
    expect(canTransition('processing', 'canceled')).toBe(false);
  });
  it('retry delays follow 5s/30s/2m/10m/30m then dead letter and honor Retry-After', () => {
    expect(retryDelaySeconds(1, null, () => 0)).toBe(5);
    expect(retryDelaySeconds(5, null, () => 0)).toBe(1800);
    expect(retryDelaySeconds(6, null, () => 0)).toBeNull();
    expect(retryDelaySeconds(1, 90, () => 0)).toBe(90);
  });
});

describe('time', () => {
  it('explicit future UTC and valid zone accepted', () => {
    expect(validateSchedule({ utc: '2026-11-02T22:00:00Z', timezone: 'Australia/Melbourne' }, new Date('2026-10-30T00:00:00Z')).utc).toBe(
      '2026-11-02T22:00:00.000Z',
    );
  });
  it('local, offset or invalid timestamps rejected', () => {
    for (const utc of ['2026-11-03T09:00', '2026-11-03T09:00:00+11:00', '2026-02-30T00:00:00Z', 'tomorrow', 1])
      expect(() => validateSchedule({ utc, timezone: 'Australia/Melbourne' }, new Date('2026-10-30T00:00:00Z'))).toThrow();
    expect(() => validateSchedule({ utc: '2026-11-02T22:00:00Z', timezone: 'Mars/Base' }, new Date('2026-10-30T00:00:00Z'))).toThrow();
    expect(() => validateSchedule({ utc: '2026-10-01T00:00:00Z', timezone: 'UTC' }, new Date('2026-10-30T00:00:00Z'))).toThrow();
  });
  it('resolves Melbourne summer time (AEDT, +11:00)', () => {
    const r = resolveLocalTime('2026-11-03T09:00', 'Australia/Melbourne');
    expect(r.utc).toBe('2026-11-02T22:00:00.000Z');
    expect(r.offset).toBe('+11:00');
  });
  it('resolves Melbourne winter time (AEST, +10:00)', () => {
    expect(resolveLocalTime('2026-07-01T09:00', 'Australia/Melbourne').utc).toBe('2026-06-30T23:00:00.000Z');
  });
  it('rejects the nonexistent 02:30 on Melbourne DST start (4 Oct 2026)', () => {
    try {
      resolveLocalTime('2026-10-04T02:30', 'Australia/Melbourne');
      expect.unreachable();
    } catch (e) {
      expect((e as ScheduleError).code).toBe('nonexistent_local_time');
    }
  });
  it('requires a choice for the ambiguous 02:30 on Melbourne DST end (5 Apr 2026)', () => {
    try {
      resolveLocalTime('2026-04-05T02:30', 'Australia/Melbourne');
      expect.unreachable();
    } catch (e) {
      const err = e as ScheduleError;
      expect(err.code).toBe('ambiguous_local_time');
      expect(err.options?.map((o) => o.offset)).toEqual(['+11:00', '+10:00']);
    }
    expect(resolveLocalTime('2026-04-05T02:30', 'Australia/Melbourne', 'earlier').utc).toBe('2026-04-04T15:30:00.000Z');
    expect(resolveLocalTime('2026-04-05T02:30', 'Australia/Melbourne', 'later').utc).toBe('2026-04-04T16:30:00.000Z');
  });
  it('describes a UTC instant in local time with offset', () => {
    expect(describeInstant('2026-11-02T22:00:00Z', 'Australia/Melbourne')).toMatchObject({ local: '2026-11-03T09:00', offset: '+11:00' });
  });
});

describe('targets', () => {
  it('validates intent shape', () => {
    expect(validateTargets([{ platform: 'linkedin', connectionId: 'c1', format: 'text', hasMedia: false }])).toBe(1);
    expect(() => validateTargets([{ platform: 'instagram', connectionId: 'c1', format: 'text', hasMedia: false }])).toThrow();
    expect(() => validateTargets([{ platform: 'youtube', connectionId: 'c1', format: 'video', hasMedia: false }])).toThrow();
    expect(() =>
      validateTargets([
        { platform: 'linkedin', connectionId: 'c1', format: 'text', hasMedia: false },
        { platform: 'linkedin', connectionId: 'c1', format: 'link', hasMedia: false },
      ]),
    ).toThrow();
    expect(() => validateTargets([{ platform: 'linkedin', connectionId: 'c1', format: 'text', hasMedia: false, extra: 1 }])).toThrow();
  });
  it('explains what must change for unsupported destinations', () => {
    expect(destinationProblems({ platform: 'instagram', format: 'text', caption: 'hi', assets: [] })[0]).toMatch(/does not support/);
    expect(destinationProblems({ platform: 'youtube', format: 'video', caption: '', assets: [] })).toEqual(
      expect.arrayContaining([expect.stringMatching(/media/), expect.stringMatching(/title/)]),
    );
    expect(
      destinationProblems({
        platform: 'linkedin',
        format: 'image',
        caption: 'ok',
        assets: [{ mime: 'image/png', validation_state: 'valid', duration_ms: null, width: 10, height: 10 }],
      }),
    ).toEqual([]);
  });
});
