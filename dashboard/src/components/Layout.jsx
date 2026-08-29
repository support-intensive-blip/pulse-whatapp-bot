import React from 'react';
import { NavLink, Outlet, useNavigate, Link } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquare,
  Zap,
  Settings2,
  LogOut,
  User,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Badge, Logo, UserAvatar } from './ds';
import { useActionItemsFeed } from '../hooks/useActionItemsFeed';
import { useActionBrowserAlerts } from '../hooks/useActionBrowserAlerts';
import NotificationBell from './NotificationBell';

const NAV = [
  { to: '/', label: 'Dashboard', end: true, icon: LayoutDashboard },
  { to: '/conversations', label: 'Chats', icon: MessageSquare },
  { to: '/actions', label: 'Call to Action', icon: Zap, badgeKey: 'actions' },
];

function NavItem({ to, end, icon: Icon, label, state, badge }) {
  return (
    <NavLink
      to={to}
      end={end}
      state={state}
      className={({ isActive }) =>
        `ds-nav-item ${isActive ? 'ds-nav-item-active' : ''}`
      }
    >
      <Icon size={20} strokeWidth={1.75} className="shrink-0" />
      <span className="flex-1">{label}</span>
      {badge > 0 && (
        <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-warning px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </NavLink>
  );
}

export default function Layout() {
  const { user, bot, logout } = useAuth();
  const navigate = useNavigate();
  const isLive = bot?.status === 'ready';
  const { pendingCount } = useActionItemsFeed();

  useActionBrowserAlerts();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="flex h-screen h-dvh overflow-hidden bg-canvas">
      <aside className="hidden h-full w-[17rem] shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-5">
          <Logo size={36} />
          <div>
            <p className="text-sm font-semibold tracking-tight text-ink">Pulse</p>
            <p className="text-xs text-ink-muted">WhatsApp AI Platform</p>
          </div>
        </div>

        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 py-4" aria-label="Main">
          <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Workspace
          </p>
          {NAV.map((item) => (
            <NavItem
              key={`${item.to}-${item.label}`}
              {...item}
              badge={item.badgeKey === 'actions' ? pendingCount : 0}
            />
          ))}
          <p className="mb-2 mt-6 px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Admin
          </p>
          <NavItem to="/settings" icon={Settings2} label="Settings" />
        </nav>

        <div className="mt-auto shrink-0 space-y-2 border-t border-border bg-surface p-4">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-slate-50/80 px-3 py-3">
            <UserAvatar name={user?.name} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{user?.name || 'Pulse user'}</p>
              <p className="truncate text-xs text-ink-muted">{user?.email || 'Signed in'}</p>
            </div>
            <Badge tone={isLive ? 'live' : 'neutral'} dot>
              {isLive ? 'Live' : 'Idle'}
            </Badge>
          </div>
          <Link to="/account" className="ds-nav-item w-full">
            <User size={20} strokeWidth={1.75} />
            <span>Profile</span>
          </Link>
          <button type="button" onClick={handleLogout} className="ds-nav-item w-full text-left">
            <LogOut size={20} strokeWidth={1.75} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between border-b border-border bg-surface/95 px-4 py-3 backdrop-blur-sm">
          <div className="flex items-center gap-2 lg:hidden">
            <Logo size={28} />
            <div>
              <span className="block font-semibold text-ink">Pulse</span>
              <span className="block text-[10px] text-ink-muted">WhatsApp AI</span>
            </div>
          </div>
          <div className="hidden text-sm text-ink-muted lg:block">
            Enterprise workspace
          </div>
          <div className="flex items-center gap-3">
            <Badge tone={isLive ? 'live' : 'neutral'} dot className="hidden sm:inline-flex">
              {isLive ? 'Connected' : 'Offline'}
            </Badge>
            <NotificationBell />
            <Link to="/account" className="hidden sm:block" aria-label="Account">
              <UserAvatar name={user?.name} size="sm" />
            </Link>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-auto p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>

        <nav
          className="flex border-t border-border bg-surface px-1 py-1.5 lg:hidden"
          aria-label="Mobile"
        >
          {[
            { to: '/', label: 'Home', end: true, icon: LayoutDashboard },
            { to: '/conversations', label: 'Chats', icon: MessageSquare },
            { to: '/actions', label: 'CTA', icon: Zap, badge: pendingCount },
            { to: '/settings', label: 'Settings', icon: Settings2 },
          ].map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `relative flex flex-1 flex-col items-center gap-0.5 rounded-lg py-2 text-[10px] font-medium transition-colors ${
                  isActive ? 'bg-primary-soft text-primary' : 'text-ink-muted'
                }`
              }
            >
              <item.icon size={18} strokeWidth={1.75} />
              {item.label}
              {item.badge > 0 && (
                <span className="absolute right-[18%] top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-warning px-1 text-[9px] font-bold text-white">
                  {item.badge > 9 ? '9+' : item.badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
