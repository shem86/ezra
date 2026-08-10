// App shell: sidebar nav + topbar + hash routing. The prototype's tweaks panel
// and the cards/dense dashboard variants are dropped; the `focus` layout is the
// one kept (spec Q6). Hash routing means no server-side SPA fallback is needed.
import { useEffect, useState } from 'react';
import { signOut, UNAUTHORIZED_EVENT, type UnauthorizedDetail } from './api/client';
import { Icon } from './components/icon';
import { Badge, Dot } from './components/primitives';
import { SignIn } from './components/sign-in';
import { isRoute, NAV, TITLES, type Route } from './routes';

// Static console branding (not mock data — the household's real group jid is
// PII and lives behind the allowlist; the console identifies itself generically).
const HOUSEHOLD = { group: 'Household', members: 2, locale: 'he / en' };
import { DatabaseScreen } from './screens/database';
import { CostsScreen } from './screens/costs';
import { LogsScreen } from './screens/logs';
import { OverviewScreen } from './screens/overview';
import { StatusScreen } from './screens/status';

function Sidebar({
  route,
  setRoute,
  onSignOut,
}: {
  route: Route;
  setRoute: (r: Route) => void;
  onSignOut: () => void;
}): React.JSX.Element {
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
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{HOUSEHOLD.group}</span>
          </div>
          <div className="household-meta">
            <span>{HOUSEHOLD.members} members</span>
            <span>·</span>
            <span>{HOUSEHOLD.locale}</span>
          </div>
        </div>
        <button className="signout" type="button" onClick={onSignOut}>
          Sign out
        </button>
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
        {/* The console has no per-operator identity; the avatar carries the Ezra
            brand mark (matches the sidebar) rather than a stray placeholder. */}
        <div className="avatar" title="Ezra">ע</div>
      </div>
    </header>
  );
}

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>(() => {
    const h = (location.hash || '').replace('#', '');
    return isRoute(h) ? h : 'dashboard';
  });
  // Any 401 or 429 from any screen raises UNAUTHORIZED_EVENT; that swaps the
  // whole shell for the sign-in form. `session` remounts the screen subtree
  // after a successful sign-in so its data loaders re-run with the fresh cookie.
  const [signedOut, setSignedOut] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [session, setSession] = useState(0);

  useEffect(() => {
    const onUnauthorized = (e: Event): void => {
      const status = (e as CustomEvent<UnauthorizedDetail>).detail?.status;
      setSignedOut(true);
      // A throttle is not a dead session: the console is healthy and a correct
      // token is still accepted while locked out, so say so rather than letting
      // the operator conclude the back office is down (2026-08-10).
      setNotice(
        status === 429
          ? 'Too many failed attempts from this address. The console is healthy — the correct token still works.'
          : null,
      );
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

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

  if (signedOut) {
    return (
      <SignIn
        notice={notice}
        onSignedIn={() => {
          setSignedOut(false);
          setNotice(null);
          setSession((n) => n + 1);
        }}
      />
    );
  }

  return (
    <div className="shell">
      <Sidebar
        route={route}
        setRoute={setRoute}
        onSignOut={() => {
          void signOut().finally(() => {
            setSignedOut(true);
            setNotice(null);
          });
        }}
      />
      <main className="main">
        <Topbar route={route} />
        <div className="content" key={session}>
          {screen[route]}
        </div>
      </main>
    </div>
  );
}
