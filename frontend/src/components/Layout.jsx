import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquare,
  Zap,
  Bot,
  BookOpen,
  BarChart3,
  Users,
  Plug,
  Settings2,
  Building2,
  Contact,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Logo, UserAvatar, formatPhone } from './ds';
import { useActionItemsFeed, fetchActionItemsFeed } from '../hooks/useActionItemsFeed';
import { useActionBrowserAlerts } from '../hooks/useActionBrowserAlerts';
import NotificationBell from './NotificationBell';

// `admin` items are hidden from team users; `owner` items only show for the owner.
const NAV_SECTIONS = [
  {
    label: 'Workspace',
    items: [
      { to: '/', label: 'Overview', end: true, icon: LayoutDashboard },
      { to: '/conversations', label: 'Inbox', icon: MessageSquare },
      { to: '/contacts', label: 'Contacts', icon: Contact },
      { to: '/actions', label: 'Call to Actions', icon: Zap, badgeKey: 'actions' },
      { to: '/analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    label: 'Team admin',
    admin: true,
    items: [
      { to: '/bots', label: 'AI Bots', icon: Bot },
      { to: '/knowledge', label: 'Knowledge Base', icon: BookOpen },
      { to: '/team', label: 'Team & Users', icon: Users },
      { to: '/integrations', label: 'Integrations', icon: Plug },
    ],
  },
  {
    label: 'Platform',
    owner: true,
    items: [{ to: '/teams', label: 'Teams', icon: Building2 }],
  },
  {
    label: 'Account',
    items: [{ to: '/settings', label: 'Settings', icon: Settings2 }],
  },
];

const ROLE_LABEL = { owner: 'Owner', team_admin: 'Team Admin', team_user: 'Team User' };

function NavItem({ to, end, icon: Icon, label, badge, onNavigate }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) => `ds-nav-item ${isActive ? 'ds-nav-item-active' : ''}`}
    >
      <Icon size={20} strokeWidth={1.75} className="shrink-0" />
      <span className="flex-1">{label}</span>
      {badge > 0 && (
        <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-warning px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </NavLink>
  );
}

function NavSections({ isAdmin, isOwner, pendingCount, onNavigate }) {
  return NAV_SECTIONS.filter((section) => (!section.admin || isAdmin) && (!section.owner || isOwner)).map((section) => (
    <div key={section.label} className="mb-5">
      <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">{section.label}</p>
      <div className="space-y-0.5">
        {section.items.map((item) => (
          <NavItem
            key={item.to}
            {...item}
            badge={item.badgeKey === 'actions' ? pendingCount : 0}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  ));
}

function ScopeSelectors({ compact = false }) {
  const { isOwner, teams, team, switchTeam, bots, currentBotId, setCurrentBotId } = useAuth();
  const selectCls =
    'h-9 rounded-lg border border-border bg-white px-2.5 text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

  return (
    <div className={`flex min-w-0 items-center gap-2 ${compact ? 'w-full flex-col items-stretch' : ''}`}>
      {isOwner && teams.length > 0 && (
        <select
          aria-label="Team"
          className={`${selectCls} ${compact ? '' : 'max-w-[12rem]'}`}
          value={team?.id || ''}
          onChange={(e) => switchTeam(Number(e.target.value))}
        >
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.isActive ? '' : ' (inactive)'}
            </option>
          ))}
        </select>
      )}
      {!isOwner && team && !compact && <span className="truncate text-sm font-medium text-ink">{team.name}</span>}
      <select
        aria-label="WhatsApp number"
        className={`${selectCls} ${compact ? '' : 'max-w-[16rem]'}`}
        value={currentBotId || ''}
        onChange={(e) => setCurrentBotId(e.target.value ? Number(e.target.value) : null)}
        disabled={!bots.length}
      >
        <option value="">{bots.length ? `All numbers (${bots.length})` : 'No numbers yet'}</option>
        {bots.map((bot) => (
          <option key={bot.id} value={bot.id}>
            {bot.name} · {formatPhone(bot.whatsappPhone)}
          </option>
        ))}
      </select>
    </div>
  );
}

function ConnectionPill() {
  const { bots, currentBot } = useAuth();
  const scoped = currentBot ? [currentBot] : bots.filter((bot) => bot.isActive);
  const up = scoped.filter((bot) => bot.connected).length;
  const allUp = scoped.length > 0 && up === scoped.length;
  const label = !scoped.length ? 'No numbers' : allUp ? 'All connected' : `${up}/${scoped.length} connected`;
  return (
    <span
      className={`hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium sm:inline-flex ${
        allUp ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : scoped.length ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-200' : 'bg-slate-100 text-ink-muted'
      }`}
      title="Gallabox connection status"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${allUp ? 'bg-success' : 'bg-warning'}`} />
      {label}
    </span>
  );
}

export default function Layout() {
  const { user, logout, isAdmin, isOwner, team, scopeVersion } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { pendingCount } = useActionItemsFeed();
  const [menuOpen, setMenuOpen] = useState(false);

  useActionBrowserAlerts();

  // The CTA badge follows the selected team / number.
  useEffect(() => {
    if (scopeVersion) fetchActionItemsFeed(undefined, { silent: true });
  }, [scopeVersion]);

  function handleLogout() {
    logout();
    navigate('/login');
  }

  const inboxRoute = location.pathname.startsWith('/conversations');

  return (
    <div className="flex h-screen h-dvh overflow-hidden bg-canvas">
      <aside className="hidden h-full w-[16.5rem] shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
          <Logo size={34} />
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight text-ink">Pulse</p>
            <p className="truncate text-xs text-ink-muted">{team?.name || 'AI Chatbot Platform'}</p>
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4" aria-label="Main">
          <NavSections isAdmin={isAdmin} isOwner={isOwner} pendingCount={pendingCount} />
        </nav>

        <div className="mt-auto shrink-0 space-y-1 border-t border-border p-3">
          <div className="flex items-center gap-3 rounded-xl bg-slate-50/80 px-3 py-2.5">
            <UserAvatar name={user?.name} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{user?.name || 'Pulse user'}</p>
              <p className="truncate text-xs text-ink-muted">{ROLE_LABEL[user?.role] || user?.email}</p>
            </div>
          </div>
          <button type="button" onClick={handleLogout} className="ds-nav-item w-full text-left">
            <LogOut size={20} strokeWidth={1.75} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface/95 px-4 py-2.5 backdrop-blur-sm">
          <Link to="/" className="flex items-center gap-2 lg:hidden" aria-label="Pulse home">
            <Logo size={28} />
          </Link>
          <div className="hidden min-w-0 flex-1 md:flex">
            <ScopeSelectors />
          </div>
          <div className="flex-1 md:hidden" />
          <div className="flex items-center gap-2.5">
            <ConnectionPill />
            <NotificationBell />
            <Link to="/settings" className="hidden sm:block" aria-label="Settings">
              <UserAvatar name={user?.name} size="sm" />
            </Link>
          </div>
        </header>

        {/* Selectors stay reachable on small screens, except inside a chat. */}
        {!inboxRoute && (
          <div className="border-b border-border bg-surface px-4 py-2 md:hidden">
            <ScopeSelectors compact />
          </div>
        )}

        <main className={`min-h-0 flex-1 ${inboxRoute ? 'overflow-hidden' : 'overflow-auto p-4 sm:p-6 lg:p-8'}`}>
          <Outlet />
        </main>

        <nav className="flex border-t border-border bg-surface px-1 py-1.5 lg:hidden" aria-label="Mobile">
          {[
            { to: '/', label: 'Home', end: true, icon: LayoutDashboard },
            { to: '/conversations', label: 'Inbox', icon: MessageSquare },
            { to: '/actions', label: 'CTA', icon: Zap, badge: pendingCount },
            { to: '/contacts', label: 'Contacts', icon: Contact },
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
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="flex flex-1 flex-col items-center gap-0.5 rounded-lg py-2 text-[10px] font-medium text-ink-muted"
          >
            <Menu size={18} strokeWidth={1.75} />
            More
          </button>
        </nav>
      </div>

      {menuOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 lg:hidden" onClick={() => setMenuOpen(false)}>
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col bg-surface shadow-lift" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm font-semibold text-ink">Menu</span>
              <button type="button" onClick={() => setMenuOpen(false)} className="rounded-lg p-1.5 text-ink-muted hover:bg-slate-100" aria-label="Close menu">
                <X size={18} />
              </button>
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
              <NavSections isAdmin={isAdmin} isOwner={isOwner} pendingCount={pendingCount} onNavigate={() => setMenuOpen(false)} />
            </nav>
            <div className="border-t border-border p-3">
              <button type="button" onClick={handleLogout} className="ds-nav-item w-full text-left">
                <LogOut size={20} strokeWidth={1.75} />
                <span>Sign out</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
