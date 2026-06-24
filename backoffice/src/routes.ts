import type { IconName } from './components/icon';

export type Route = 'dashboard' | 'database' | 'logs' | 'costs' | 'status';

export const NAV: { id: Route; label: string; icon: IconName }[] = [
  { id: 'dashboard', label: 'Overview', icon: 'dashboard' },
  { id: 'database', label: 'Database', icon: 'database' },
  { id: 'logs', label: 'Logs', icon: 'logs' },
  { id: 'costs', label: 'Costs', icon: 'costs' },
  { id: 'status', label: 'Status', icon: 'status' },
];

export const TITLES: Record<Route, string> = {
  dashboard: 'Overview',
  database: 'Database',
  logs: 'Logs',
  costs: 'Costs & tokenomics',
  status: 'System status',
};

export function isRoute(value: string): value is Route {
  return NAV.some((n) => n.id === value);
}
