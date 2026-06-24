// App shell: sidebar nav + topbar + hash routing. The prototype's tweaks panel
// and the cards/dense dashboard variants are dropped; the `focus` layout is the
// one kept (spec Q6). Hash routing means no server-side SPA fallback is needed.
import { useEffect, useState } from 'react';
import { Icon } from './components/icon';
import { Badge, Dot } from './components/primitives';
import { household } from './fixtures';
import { isRoute, NAV, TITLES, type Route } from './routes';
import { DatabaseScreen } from './screens/database';
import { CostsScreen } from './screens/costs';
import { LogsScreen } from './screens/logs';
import { OverviewScreen } from './screens/overview';
import { StatusScreen } from './screens/status';

function Sidebar({ route, setRoute }: { route: Route; setRoute: (r: Route) => void }): React.JSX.Element {
  return (
    <aside className="sidebar" data-tone="warm">
      <div className="brand">
        <div className="brand-mark">ע</div>
        <div>
          <div className="brand-name">Ezra</div>
          <div className="brand-sub">backoffice</div>
        </div>
      </div>

      <nav className="nav">
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setRoute(n.id)}
            className={'navitem' + (route === n.id ? ' on' : '')}
          >
            <Icon name={n.icon} size={18} />
            <span>{n.label}</span>
          </button>
        ))}
      </nav>

      <div className="side-foot">
        <div className="household">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Dot status="operational" pulse />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{household.group}</span>
          </div>
          <div className="household-meta">
            <span>{household.members} members</span>
            <span>·</span>
            <span>{household.locale}</span>
          </div>
          <div className="household-meta" style={{ fontFamily: 'var(--mono)' }}>
            {household.jid}
          </div>
        </div>
      </div>
    </aside>
  );
}

function Topbar({ route }: { route: Route }): React.JSX.Element {
  return (
    <header className="topbar">
      <div>
        <div className="crumb">Ezra · WhatsApp household assistant</div>
        <h1 className="page-title">{TITLES[route]}</h1>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Badge tone="ok">
          <Dot status="operational" size={7} /> live
        </Badge>
        <div className="avatar">N</div>
      </div>
    </header>
  );
}

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>(() => {
    const h = (location.hash || '').replace('#', '');
    return isRoute(h) ? h : 'dashboard';
  });

  useEffect(() => {
    location.hash = route;
  }, [route]);

  useEffect(() => {
    const onHash = (): void => {
      const h = (location.hash || '').replace('#', '');
      if (isRoute(h)) setRoute(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const screen: Record<Route, React.JSX.Element> = {
    dashboard: <OverviewScreen onOpen={setRoute} />,
    database: <DatabaseScreen />,
    logs: <LogsScreen />,
    costs: <CostsScreen />,
    status: <StatusScreen />,
  };

  return (
    <div className="shell">
      <Sidebar route={route} setRoute={setRoute} />
      <main className="main">
        <Topbar route={route} />
        <div className="content">{screen[route]}</div>
      </main>
    </div>
  );
}
