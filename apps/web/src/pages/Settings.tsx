import { useSearchParams } from 'react-router';
import { PageHeader } from '../components/ui';
import { DataTab } from '../features/settings/DataTab';
import { EventsTab } from '../features/settings/EventsTab';
import { MembersTab } from '../features/settings/MembersTab';
import { NotificationsTab } from '../features/settings/NotificationsTab';
import { ProductsTab } from '../features/settings/ProductsTab';
import { SecurityTab } from '../features/settings/SecurityTab';
import { WorkspaceTab } from '../features/settings/WorkspaceTab';

const TABS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'products', label: 'Products' },
  { id: 'members', label: 'Members' },
  { id: 'events', label: 'Events' },
  { id: 'security', label: 'Security' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'data', label: 'Data' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: TabId = TABS.some((t) => t.id === requested) ? (requested as TabId) : 'workspace';
  const select = (id: TabId) => setParams({ tab: id }, { replace: true });

  return (
    <>
      <PageHeader title="Settings" subtitle="Your workspace, products, team and controls." />
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`settings-tab-${t.id}`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === t.id}
            aria-controls={`settings-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => select(t.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length]!;
              select(next.id);
              document.getElementById(`settings-tab-${next.id}`)?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} className="stack">
        {tab === 'workspace' ? <WorkspaceTab /> : null}
        {tab === 'products' ? <ProductsTab /> : null}
        {tab === 'members' ? <MembersTab /> : null}
        {tab === 'events' ? <EventsTab /> : null}
        {tab === 'security' ? <SecurityTab /> : null}
        {tab === 'notifications' ? <NotificationsTab /> : null}
        {tab === 'data' ? <DataTab /> : null}
      </div>
    </>
  );
}
