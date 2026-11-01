import { useId } from 'react';
import { formatLocalAndUtc, nowMs, zoneCity } from '../lib/format';
import { MIN_LEAD_MS, resolveSchedule, type ResolveResult } from '../lib/schedule';

export interface LocalTimeValue {
  date: string;
  time: string;
  occurrence?: 'earlier' | 'later' | undefined;
}

/** Returns the resolved instant, or a reason the input cannot be scheduled. */
export function evaluateLocalTime(v: LocalTimeValue, timezone: string): ResolveResult & { past?: boolean } {
  const r = resolveSchedule(v.date, v.time, timezone, v.occurrence);
  if (r.kind === 'ok' && new Date(r.time.utc).getTime() < nowMs() + MIN_LEAD_MS) return { ...r, past: true };
  return r;
}

export function LocalTimePicker({ value, onChange, timezone, legend = 'Schedule' }: { value: LocalTimeValue; onChange: (v: LocalTimeValue) => void; timezone: string; legend?: string }) {
  const id = useId();
  const r = evaluateLocalTime(value, timezone);
  return (
    <fieldset className="stack-sm">
      <legend>
        {legend} / {zoneCity(timezone)} ({timezone})
      </legend>
      <div className="grid-2" style={{ gap: 12 }}>
        <div className="field">
          <label htmlFor={`${id}-d`}>Date</label>
          <input id={`${id}-d`} className="input" type="date" value={value.date} onChange={(e) => onChange({ date: e.target.value, time: value.time })} aria-describedby={`${id}-out`} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-t`}>Time</label>
          <input id={`${id}-t`} className="input" type="time" value={value.time} onChange={(e) => onChange({ date: value.date, time: e.target.value })} aria-describedby={`${id}-out`} />
        </div>
      </div>
      {r.kind === 'ambiguous' ? (
        <fieldset className="stack-sm">
          <legend>{r.message}</legend>
          <div className="choice-group">
            {(['earlier', 'later'] as const).map((occ, i) => {
              const opt = r.options[occ === 'earlier' ? 0 : r.options.length - 1];
              return (
                <label key={occ} className="choice">
                  <input type="radio" name={`${id}-occ`} checked={value.occurrence === occ} onChange={() => onChange({ ...value, occurrence: occ })} />
                  <span>
                    {i === 0 ? 'Earlier' : 'Later'} occurrence {opt ? `(UTC${opt.offset}, ${formatLocalAndUtc(opt.utc, timezone)})` : ''}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      <p id={`${id}-out`} className={r.kind === 'error' || r.past ? 'field-error' : 'small'} aria-live="polite">
        {r.kind === 'empty' ? 'Choose a date and time.' : null}
        {r.kind === 'error' ? r.message : null}
        {r.kind === 'ok' ? (
          <>
            <span className="strong">{formatLocalAndUtc(r.time.utc, timezone)}</span>
            <span className="muted"> · UTC{r.time.offset}</span>
            {r.past ? <span> — choose a time at least a few minutes in the future.</span> : null}
          </>
        ) : null}
      </p>
    </fieldset>
  );
}
