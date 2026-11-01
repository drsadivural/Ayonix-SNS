// Hand-written accessible SVG charts. Every chart has a text summary and a
// visually-hidden data table; missing values are gaps, never zeros.
import { useId } from 'react';
import type { AnalyticsResponse, MetricPoint } from '@ayonix/contracts';
import { formatMetric, formatNumber, formatSeriesDate, NOT_AVAILABLE } from '../lib/format';
import { PLATFORM_LABELS } from '../lib/labels';

const W = 600;
const H = 200;

export function summarizeSeries(points: MetricPoint[], metricLabel: string): string {
  const known = points.filter((p): p is { date: string; value: number } => p.value !== null);
  if (!points.length) return `No ${metricLabel.toLowerCase()} data for this period.`;
  if (!known.length) return `${metricLabel} is not available for any day in this period.`;
  const total = known.reduce((s, p) => s + p.value, 0);
  const peak = known.reduce((a, b) => (b.value > a.value ? b : a));
  const first = points[0]!.date;
  const last = points[points.length - 1]!.date;
  const missing = points.length - known.length;
  return `${metricLabel} from ${formatSeriesDate(first)} to ${formatSeriesDate(last)}: ${formatNumber(total)} in total across ${known.length} day${known.length === 1 ? '' : 's'} with data. Highest: ${formatNumber(peak.value)} on ${formatSeriesDate(peak.date)}.${missing ? ` ${missing} day${missing === 1 ? '' : 's'} not available.` : ''}`;
}

export function AreaChart({ points, metricLabel, title }: { points: MetricPoint[]; metricLabel: string; title: string }) {
  const id = useId();
  const known = points.filter((p) => p.value !== null);
  const summary = summarizeSeries(points, metricLabel);
  if (!known.length) {
    return (
      <div className="empty">
        <h3>{NOT_AVAILABLE}</h3>
        <p className="muted small">
          {summary} Networks that do not report this metric are excluded, never counted as zero.
        </p>
      </div>
    );
  }
  const max = Math.max(...known.map((p) => p.value ?? 0), 1);
  const n = points.length;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - (v / max) * (H - 10);
  // Split into contiguous runs so unavailable days render as gaps.
  const runs: Array<Array<{ i: number; v: number }>> = [];
  let cur: Array<{ i: number; v: number }> = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push({ i, v: p.value });
  });
  if (cur.length) runs.push(cur);

  return (
    <figure className="chart">
      <div className="chart-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-labelledby={`${id}-t ${id}-d`}>
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>{summary}</desc>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1={0} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="var(--chart-grid)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {runs.map((run, k) => {
            const line = run.map((p, j) => `${j ? 'L' : 'M'}${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
            const area = `${line} L${x(run[run.length - 1]!.i).toFixed(2)},${H} L${x(run[0]!.i).toFixed(2)},${H} Z`;
            return (
              <g key={k}>
                <path d={area} fill="var(--chart-area)" />
                <path d={line} fill="none" stroke="var(--chart-line)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                {run.length === 1 ? <circle cx={x(run[0]!.i)} cy={y(run[0]!.v)} r={4} fill="var(--chart-line)" /> : null}
              </g>
            );
          })}
        </svg>
        <span className="chart-ymax" aria-hidden="true">
          {formatNumber(max)}
        </span>
      </div>
      <div className="chart-axis" aria-hidden="true">
        <span>{formatSeriesDate(points[0]!.date)}</span>
        <span>{formatSeriesDate(points[points.length - 1]!.date)}</span>
      </div>
      <figcaption>{summary}</figcaption>
      <table className="visually-hidden">
        <caption>{title} by day</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">{metricLabel}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <th scope="row">{p.date}</th>
              <td>{formatMetric(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function ChannelBars({ rows }: { rows: AnalyticsResponse['by_channel'] }) {
  const max = Math.max(1, ...rows.map((r) => r.impressions ?? 0));
  if (!rows.length) return <p className="muted small">No channels match these filters.</p>;
  return (
    <ul className="bars">
      {rows.map((r) => {
        const available = r.available && r.impressions !== null;
        const pct = available ? Math.max(2, Math.round(((r.impressions ?? 0) / max) * 100)) : 0;
        return (
          <li key={r.platform} className="bar-row">
            <span className="strong">{PLATFORM_LABELS[r.platform]}</span>
            {available ? (
              <span className="bar-track" aria-hidden="true">
                <span className="bar-fill" style={{ width: `${pct}%` }} />
              </span>
            ) : (
              <span className="small muted">{NOT_AVAILABLE}</span>
            )}
            <span className="bar-value">
              {available ? `${formatMetric(r.impressions)} impressions · ${formatMetric(r.engagements)} engagements` : r.note ?? 'This network does not report this metric for the connected account.'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
