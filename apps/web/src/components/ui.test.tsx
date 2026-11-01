import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { formatMetric } from '../lib/format';
import { StatCard, StatusBadge } from './ui';
import { ChannelBars } from './charts';

describe('metric rendering', () => {
  it('renders null metrics as "Not available", never 0', () => {
    render(<StatCard label="Impressions" value={null} />);
    const card = screen.getByRole('region', { name: 'Impressions' });
    expect(card.textContent).toContain('Not available');
    expect(card.textContent).not.toMatch(/\b0\b/);
  });

  it('renders a measured zero as 0', () => {
    render(<StatCard label="Published" value={0} />);
    expect(screen.getByRole('region', { name: 'Published' }).textContent).toContain('0');
  });

  it('formatMetric distinguishes null from zero', () => {
    expect(formatMetric(null)).toBe('Not available');
    expect(formatMetric(undefined)).toBe('Not available');
    expect(formatMetric(0)).toBe('0');
    expect(formatMetric(124820)).toBe('124,820');
  });

  it('shows "Not available" rows with their note in the channel breakdown', () => {
    render(
      <ChannelBars
        rows={[
          { platform: 'linkedin', impressions: 10, engagements: 2, retrieved_at: '2026-10-31T00:00:00Z', available: true, note: null },
          { platform: 'tiktok', impressions: null, engagements: null, retrieved_at: null, available: false, note: 'TikTok does not report impressions for this account.' },
        ]}
      />,
    );
    expect(screen.getByText('Not available')).toBeTruthy();
    expect(screen.getByText('TikTok does not report impressions for this account.')).toBeTruthy();
  });

  it('status badges always carry text', () => {
    render(<StatusBadge state="outcome_unknown" />);
    expect(screen.getByText('Outcome unknown')).toBeTruthy();
  });
});
