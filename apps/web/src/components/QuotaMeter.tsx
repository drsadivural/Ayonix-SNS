import type { QuotaSummary } from '@ayonix/contracts';
import { formatDate, formatNumber } from '../lib/format';

export function QuotaMeter({ quota, timezone, extra = 0 }: { quota: QuotaSummary; timezone: string; extra?: number }) {
  if (!quota.period_id || quota.allowance <= 0) {
    return (
      <div className="quota">
        <p className="strong">Publications this cycle</p>
        <p className="small muted">No active billing cycle, so no publications can be reserved.</p>
      </div>
    );
  }
  const pct = (n: number) => `${Math.min(100, Math.max(0, (n / quota.allowance) * 100))}%`;
  const label = `${formatNumber(quota.used)} used and ${formatNumber(quota.reserved)} reserved of ${formatNumber(quota.allowance)} publications; ${formatNumber(quota.available)} available`;
  return (
    <div className="quota">
      <div className="row-between">
        <p className="strong">Publications this cycle</p>
        <p className="small muted">
          {formatNumber(quota.available)} of {formatNumber(quota.allowance)} available
        </p>
      </div>
      <div className="meter" role="img" aria-label={label}>
        <span className="used" style={{ width: pct(quota.used) }} />
        <span className="reserved" style={{ width: pct(quota.reserved + extra) }} />
      </div>
      <p className="legend">
        <span>Used: {formatNumber(quota.used)}</span>
        <span>Reserved: {formatNumber(quota.reserved)}</span>
        {extra ? <span>This schedule: {formatNumber(extra)}</span> : null}
        <span>
          Cycle: {formatDate(quota.starts_at, timezone)} – {formatDate(quota.ends_at, timezone)}
        </span>
      </p>
    </div>
  );
}
