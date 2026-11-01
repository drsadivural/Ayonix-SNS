// Formatting helpers. Times are always shown in an explicit IANA zone
// (normally the workspace timezone) and, for scheduling, with UTC alongside.

export const NOT_AVAILABLE = 'Not available';

const numberFmt = new Intl.NumberFormat('en-US');

export function formatNumber(n: number): string {
  return numberFmt.format(n);
}

/** null means the metric is unavailable; 0 is shown only for a measured zero. */
export function formatMetric(n: number | null | undefined): string {
  return n === null || n === undefined ? NOT_AVAILABLE : formatNumber(n);
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function parts(utc: string | number | Date, timeZone: string) {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
    partsCache.set(timeZone, f);
  }
  const d = utc instanceof Date ? utc : new Date(utc);
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    year: p.year ?? '',
    month: (p.month ?? '').replace('.', ''),
    day: p.day ?? '',
    hour: p.hour ?? '',
    minute: p.minute ?? '',
    weekday: p.weekday ?? '',
  };
}

function safeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** "03 Nov 2026 09:00" in the given zone. */
export function formatDateTime(utc: string | null | undefined, tz: string): string {
  if (!utc || !Number.isFinite(new Date(utc).getTime())) return NOT_AVAILABLE;
  const p = parts(utc, safeZone(tz));
  return `${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute}`;
}

/** "03 Nov, 09:00" in the given zone (queue tables). */
export function formatShortDateTime(utc: string, tz: string): string {
  if (!Number.isFinite(new Date(utc).getTime())) return NOT_AVAILABLE;
  const p = parts(utc, safeZone(tz));
  return `${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}

/** "03 Nov 2026" in the given zone. */
export function formatDate(utc: string | null | undefined, tz = 'UTC'): string {
  if (!utc || !Number.isFinite(new Date(utc).getTime())) return NOT_AVAILABLE;
  const p = parts(utc, safeZone(tz));
  return `${p.day} ${p.month} ${p.year}`;
}

/** "03 Nov 2026 09:00 (02 Nov 22:00 UTC)" — local wall time plus the UTC instant. */
export function formatLocalAndUtc(utc: string, tz: string): string {
  if (!Number.isFinite(new Date(utc).getTime())) return NOT_AVAILABLE;
  const l = parts(utc, safeZone(tz));
  const u = parts(utc, 'UTC');
  if (safeZone(tz) === 'UTC') return `${l.day} ${l.month} ${l.year} ${l.hour}:${l.minute} UTC`;
  return `${l.day} ${l.month} ${l.year} ${l.hour}:${l.minute} (${u.day} ${u.month} ${u.hour}:${u.minute} UTC)`;
}

/** Calendar day key "YYYY-MM-DD" of an instant in a zone. */
export function dayKey(utc: string | number, tz: string): string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: safeZone(tz), year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date(utc));
}

/** Short label for "YYYY-MM-DD" series dates (UTC calendar dates). */
export function formatSeriesDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return date;
  const p = parts(d, 'UTC');
  return `${p.day} ${p.month}`;
}

/** Last path segment of an IANA zone, e.g. "Melbourne". */
export function zoneCity(tz: string): string {
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatRelative(iso: string | null | undefined, now: number): string {
  if (!iso) return NOT_AVAILABLE;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return NOT_AVAILABLE;
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60) return rtf.format(-diff, 'second');
  if (abs < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  return rtf.format(-Math.round(diff / 86400), 'day');
}

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export interface DateRange {
  days: number;
  from: string;
  to: string;
}

/** Rolling range ending now. Called from event handlers / state initialisers only. */
export function rollingRange(days: number, endMs: number = Date.now()): DateRange {
  return { days, from: new Date(endMs - days * 86400_000).toISOString(), to: new Date(endMs).toISOString() };
}

/** The equal-length range immediately before `r`. */
export function previousRange(r: DateRange): DateRange {
  const from = new Date(r.from).getTime();
  const to = new Date(r.to).getTime();
  return { days: r.days, from: new Date(from - (to - from)).toISOString(), to: new Date(from).toISOString() };
}

export function nowMs(): number {
  return Date.now();
}

export function timezones(): string[] {
  try {
    const list = Intl.supportedValuesOf('timeZone');
    return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    return ['UTC'];
  }
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
