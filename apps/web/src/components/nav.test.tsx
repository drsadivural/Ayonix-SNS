import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { BottomNav, NAV_ITEMS, PrimaryNav, sectionFor } from './nav';

const EXPECTED = ['Dashboard', 'Connectors', 'Billings', 'Reports', 'Settings'];

describe('navigation', () => {
  it('defines exactly five top-level menus', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(EXPECTED);
  });

  it('renders exactly five links in the sidebar nav, marking the current page', () => {
    render(
      <MemoryRouter initialEntries={['/billings']}>
        <PrimaryNav pathname="/billings" />
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(EXPECTED);
    expect(within(nav).getByRole('link', { name: 'Billings' }).getAttribute('aria-current')).toBe('page');
  });

  it('renders exactly five text-labelled links in the mobile bottom nav', () => {
    render(
      <MemoryRouter>
        <BottomNav pathname="/dashboard" />
      </MemoryRouter>,
    );
    const links = within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(links.map((l) => l.textContent)).toEqual(EXPECTED);
  });

  it('keeps post details and approvals under Dashboard', () => {
    expect(sectionFor('/targets/tgt_1')).toBe('/dashboard');
    expect(sectionFor('/approve/tiktok/tgt_1')).toBe('/dashboard');
    expect(sectionFor('/settings')).toBe('/settings');
  });
});
