import { useCallback, useEffect, useRef, useState } from 'react';

import { Link } from 'react-router-dom';

import { Bell, KeyRound, MessageSquare, ShieldAlert, X, Zap } from 'lucide-react';

import { notificationsApi } from '../api/client';

import { actionItemChatUrl } from '../utils/actionLinks';



function formatWhen(iso) {

  if (!iso) return '';

  const date = new Date(iso);

  const now = Date.now();

  const diffMs = now - date.getTime();

  if (diffMs < 60_000) return 'Just now';

  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;

  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;

  return date.toLocaleDateString();

}



function alertIcon(type) {

  if (type === 'cta_created') {

    return { Icon: Zap, className: 'text-primary' };

  }

  if (type === 'firewall_blocked') {

    return { Icon: ShieldAlert, className: 'text-amber-600' };

  }

  return { Icon: KeyRound, className: 'text-amber-600' };

}



export default function NotificationBell() {

  const [open, setOpen] = useState(false);

  const [alerts, setAlerts] = useState([]);

  const [unreadCount, setUnreadCount] = useState(0);

  const [loading, setLoading] = useState(false);

  const panelRef = useRef(null);

  const buttonRef = useRef(null);



  const refresh = useCallback(async () => {

    try {

      const data = await notificationsApi.inbox();

      setAlerts(data.alerts || []);

      setUnreadCount(data.unreadCount || 0);

    } catch {

      // ignore transient errors

    } finally {

      setLoading(false);

    }

  }, []);



  useEffect(() => {

    setLoading(true);

    refresh();

    const timer = setInterval(refresh, 10000);

    return () => clearInterval(timer);

  }, [refresh]);



  useEffect(() => {

    if (!open) return undefined;



    function onPointerDown(event) {

      if (

        panelRef.current?.contains(event.target)

        || buttonRef.current?.contains(event.target)

      ) {

        return;

      }

      setOpen(false);

    }



    document.addEventListener('pointerdown', onPointerDown);

    return () => document.removeEventListener('pointerdown', onPointerDown);

  }, [open]);



  async function markRead(alertId) {

    try {

      const data = await notificationsApi.markRead(alertId);

      setUnreadCount(data.unreadCount || 0);

      setAlerts((prev) =>

        prev.map((alert) => (alert.id === alertId ? { ...alert, read: true } : alert))

      );

    } catch {

      // ignore

    }

  }



  async function markAllRead() {

    try {

      await notificationsApi.markAllRead();

      setUnreadCount(0);

      setAlerts((prev) => prev.map((alert) => ({ ...alert, read: true })));

    } catch {

      // ignore

    }

  }



  const ctaAlerts = alerts.filter((alert) => alert.type === 'cta_created');

  const systemAlerts = alerts.filter((alert) => alert.type !== 'cta_created');



  function renderAlert(alert) {

    const { Icon, className } = alertIcon(alert.type);

    const chatUrl =

      alert.type === 'cta_created' && alert.chat_profile_id

        ? actionItemChatUrl({

            chat_profile_id: alert.chat_profile_id,

            trigger_message_id: alert.trigger_message_id,

          })

        : alert.chat_profile_id

          ? `/conversations/${alert.chat_profile_id}`

          : null;



    return (

      <li key={alert.id}>

        <div className={`px-4 py-3 ${alert.read ? 'bg-surface' : 'bg-amber-50/60'}`}>

          <div className="flex items-start gap-2">

            <Icon size={16} className={`mt-0.5 shrink-0 ${className}`} strokeWidth={1.75} />

            <div className="min-w-0 flex-1">

              <p className="text-sm font-medium text-ink">{alert.title}</p>

              <p className="mt-0.5 text-xs text-ink-muted">

                <span className="font-medium text-ink">{alert.contact_name || 'Contact'}</span>

                {alert.body && alert.type !== 'cta_created' ? ` — "${alert.body}"` : ''}

                {alert.body && alert.type === 'cta_created' ? ` · ${alert.body}` : ''}

              </p>

              <p className="mt-1 text-[11px] text-ink-muted">{formatWhen(alert.created_at)}</p>

              <div className="mt-2 flex flex-wrap gap-2">

                {chatUrl && (

                  <Link

                    to={chatUrl}

                    onClick={() => {

                      if (!alert.read) markRead(alert.id);

                      setOpen(false);

                    }}

                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"

                  >

                    <MessageSquare size={12} />

                    {alert.type === 'cta_created' ? 'View CTA' : 'Open chat'}

                  </Link>

                )}

                {alert.type === 'no_api_key_message' && (

                  <Link

                    to="/settings"

                    state={{ tab: 'models' }}

                    onClick={() => {

                      if (!alert.read) markRead(alert.id);

                      setOpen(false);

                    }}

                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"

                  >

                    <KeyRound size={12} />

                    Add API key

                  </Link>

                )}

                {alert.type === 'firewall_blocked' && (

                  <Link

                    to="/settings"

                    state={{ tab: 'actions' }}

                    onClick={() => {

                      if (!alert.read) markRead(alert.id);

                      setOpen(false);

                    }}

                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"

                  >

                    <ShieldAlert size={12} />

                    Guardrails

                  </Link>

                )}

                {alert.type === 'cta_created' && (

                  <Link

                    to="/actions"

                    onClick={() => {

                      if (!alert.read) markRead(alert.id);

                      setOpen(false);

                    }}

                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"

                  >

                    <Zap size={12} />

                    All CTAs

                  </Link>

                )}

              </div>

            </div>

          </div>

        </div>

      </li>

    );

  }



  return (

    <div className="relative">

      <button

        ref={buttonRef}

        type="button"

        onClick={() => setOpen((value) => !value)}

        className="relative rounded-lg p-2 text-ink-muted transition-colors hover:bg-slate-100 hover:text-ink"

        aria-label="Notifications"

      >

        <Bell size={20} strokeWidth={1.75} />

        {unreadCount > 0 && (

          <span className="absolute right-1 top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">

            {unreadCount > 9 ? '9+' : unreadCount}

          </span>

        )}

      </button>



      {open && (

        <div

          ref={panelRef}

          className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-surface shadow-lg"

        >

          <div className="flex items-center justify-between border-b border-border px-4 py-3">

            <p className="text-sm font-semibold text-ink">Notifications</p>

            <div className="flex items-center gap-2">

              {unreadCount > 0 && (

                <button

                  type="button"

                  onClick={markAllRead}

                  className="text-xs font-medium text-primary hover:underline"

                >

                  Mark all read

                </button>

              )}

              <button

                type="button"

                onClick={() => setOpen(false)}

                className="rounded p-1 text-ink-muted hover:bg-slate-100 hover:text-ink"

                aria-label="Close notifications"

              >

                <X size={16} />

              </button>

            </div>

          </div>



          <div className="max-h-80 overflow-y-auto">

            {loading && alerts.length === 0 ? (

              <p className="px-4 py-6 text-center text-sm text-ink-muted">Loading…</p>

            ) : alerts.length === 0 ? (

              <p className="px-4 py-6 text-center text-sm text-ink-muted">No notifications</p>

            ) : (

              <>

                {ctaAlerts.length > 0 && (

                  <div>

                    <p className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">

                      Call to Action

                    </p>

                    <ul className="divide-y divide-border">{ctaAlerts.map(renderAlert)}</ul>

                  </div>

                )}

                {systemAlerts.length > 0 && (

                  <div>

                    <p className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">

                      System alerts

                    </p>

                    <ul className="divide-y divide-border">{systemAlerts.map(renderAlert)}</ul>

                  </div>

                )}

              </>

            )}

          </div>

        </div>

      )}

    </div>

  );

}

