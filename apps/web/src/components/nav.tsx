// Exactly five top-level menus. Do not add items here: product profiles,
// media, calendar etc. live inside these pages.
import { Link } from 'react-router';

export const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', short: 'Dashboard', icon: 'M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z' },
  { to: '/connectors', label: 'Connectors', short: 'Connectors', icon: 'M7 7h4V3H7v4Zm6 0h4V3h-4v4ZM9 9v4a3 3 0 0 0 6 0V9H9Zm2 8v4h2v-4h-2Z' },
  { to: '/billings', label: 'Billings', short: 'Billings', icon: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Zm2 2v2h14V8H5Zm0 6v4h6v-4H5Z' },
  { to: '/reports', label: 'Reports', short: 'Reports', icon: 'M4 20V10h3v10H4Zm6.5 0V4h3v16h-3ZM17 20v-7h3v7h-3Z' },
  { to: '/settings', label: 'Settings', short: 'Settings', icon: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.5 4 2-1.6-2-3.4-2.4.8a7 7 0 0 0-1.8-1L16 4h-4l-.4 2.8a7 7 0 0 0-1.8 1L7.5 7 5.5 10.4 7.5 12l-2 1.6 2 3.4 2.4-.8a7 7 0 0 0 1.8 1L12 20h4l.4-2.8a7 7 0 0 0 1.8-1l2.4.8 2-3.4-2.1-1.6Z' },
] as const;

/** Which top-level menu a path belongs to (post details and approvals sit under Dashboard). */
export function sectionFor(pathname: string): string | null {
  if (pathname === '/' || /^\/(targets|approve|upload)(\/|$)/.test(pathname)) return '/dashboard';
  const hit = NAV_ITEMS.find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
  return hit ? hit.to : null;
}

const isActive = (pathname: string, to: string) => sectionFor(pathname) === to;

export function PrimaryNav({ pathname, label = 'Main' }: { pathname: string; label?: string }) {
  return (
    <nav className="primary-nav" aria-label={label}>
      <ul>
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <Link to={item.to} aria-current={isActive(pathname, item.to) ? 'page' : undefined}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function BottomNav({ pathname }: { pathname: string }) {
  return (
    <nav className="bottom-nav" aria-label="Main">
      <ul>
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <Link to={item.to} aria-current={isActive(pathname, item.to) ? 'page' : undefined}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d={item.icon} fill="currentColor" />
              </svg>
              <span>{item.short}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
