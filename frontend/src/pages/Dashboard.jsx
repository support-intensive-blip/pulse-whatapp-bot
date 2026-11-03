import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Bot,
  Building2,
  Clock,
  MessageSquare,
  Phone,
  Sparkles,
  UserRound,
  Zap,
  ArrowUpRight,
  RefreshCw,
} from 'lucide-react';
import { analyticsApi, dataApi, teamsApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  AiStatusBadge,
  Alert,
  ButtonLink,
  Card,
  ConnectionBadge,
  EmptyState,
  SectionHeader,
  StatCard,
  StatCardSkeleton,
  formatPhone,
} from '../components/ds';
import { LineChart } from '../components/charts/LineChart';

function countStatus(rows, statuses) {
  return (rows || []).filter((r) => statuses.includes(r.status)).reduce((sum, r) => sum + r.count, 0);
}

function OwnerOverview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    teamsApi.overview().then(setData).catch((err) => setError(err.message));
  }, []);

  if (error) return <Alert tone="error">{error}</Alert>;
  const t = data?.totals;

  return (
    <section className="mb-10">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Platform</p>
          <h2 className="text-lg font-semibold text-ink">All teams</h2>
        </div>
        <ButtonLink to="/teams" variant="secondary" size="sm">Manage teams</ButtonLink>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {!t ? (
          Array.from({ length: 5 }).map((_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <StatCard icon={Building2} label="Teams" value={t.teams} hint={`${t.activeTeams} active`} />
            <StatCard icon={Phone} label="Connected numbers" value={t.numbers} />
            <StatCard icon={Bot} label="Active AI bots" value={t.activeBots} hint={t.testingBots ? `${t.testingBots} in testing` : null} />
            <StatCard icon={MessageSquare} label="Conversations" value={t.conversations.toLocaleString('en-IN')} />
            <StatCard icon={Zap} label="Open action items" value={t.openActionItems} />
          </>
        )}
      </div>
      {data?.alerts?.length > 0 && (
        <Card className="mt-4">
          <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
            <AlertTriangle size={16} className="text-warning" /> Integration health
          </p>
          <ul className="divide-y divide-border">
            {data.alerts.map((a) => (
              <li key={a.botId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="text-ink">
                  {a.botName} <span className="text-ink-muted">· {a.teamName}</span>
                </span>
                <span className="text-xs text-red-700">{a.problem}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

function TeamOverview() {
  const { team, bots, currentBot, isAdmin, scopeVersion } = useAuth();
  const [stats, setStats] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [awaiting, setAwaiting] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setError('');
    setRefreshing(true);
    try {
      const [s, a, w] = await Promise.all([
        dataApi.stats(true),
        analyticsApi.get(14),
        dataApi.conversations('', 'all', { awaiting: 1, limit: 1000 }),
      ]);
      if (version !== requestVersion.current) return;
      setStats(s);
      setAnalytics(a);
      setAwaiting(w.count);
      setUpdatedAt(new Date());
    } catch (err) {
      if (version === requestVersion.current) setError(err.message);
    } finally {
      if (version === requestVersion.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    setStats(null);
    setAnalytics(null);
    setAwaiting(null);
    setUpdatedAt(null);
    if (team) load();
    return () => { requestVersion.current++; };
  }, [team, scopeVersion, load]);

  if (!team) {
    return <EmptyState icon={Building2} title="No team yet" description="Create a team to start connecting WhatsApp numbers." action={<ButtonLink to="/teams">Create team</ButtonLink>} />;
  }

  if (!bots.length) {
    return (
      <EmptyState
        icon={Phone}
        title="No WhatsApp numbers connected"
        description={isAdmin ? 'Connect a Gallabox WhatsApp number to start answering students with AI.' : 'Ask your team admin to connect a WhatsApp number.'}
        action={isAdmin ? <ButtonLink to="/bots/new">Connect WhatsApp number</ButtonLink> : null}
      />
    );
  }

  const scopedBots = stats?.bots || [];
  const totals = analytics?.totals;
  const pendingCtas = countStatus(stats?.actionItems, ['open', 'in_progress']);
  const series = analytics?.series;

  return (
    <section>
      <div className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{team.name}</p>
        <h2 className="text-lg font-semibold text-ink">{currentBot ? currentBot.name : 'All numbers'}</h2>
      </div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-muted" aria-live="polite">{refreshing ? 'Updating your workspace…' : updatedAt ? `Updated ${updatedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'Waiting for workspace data'}</p>
        <button type="button" disabled={refreshing} onClick={load} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-white px-3 text-sm font-medium text-ink hover:bg-slate-50 disabled:opacity-50"><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />Refresh</button>
      </div>
      {error && <Alert tone="error" className="mb-4">Could not update the workspace. {error} Use Refresh to try again.</Alert>}
      <div className="mb-8 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 text-white">
        <div className="border-b border-white/10 p-5 sm:p-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-teal-300">Your next steps</p>
          <h3 className="text-xl font-semibold tracking-tight">Start with the conversations that need you.</h3>
          <p className="mt-2 max-w-xl text-sm text-slate-300">Review unanswered messages and follow up on open actions. AI activity is shown below.</p>
        </div>
        <div className="grid sm:grid-cols-2">
          <Link to="/conversations?filter=awaiting" className="group flex items-center justify-between gap-4 border-b border-white/10 p-5 transition-colors hover:bg-white/5 sm:border-b-0 sm:border-r sm:p-6">
            <div><span className="text-3xl font-semibold tabular-nums">{awaiting ?? '—'}</span><p className="mt-1 font-medium">Awaiting a reply</p><p className="mt-1 text-xs text-slate-300">The latest message is from the contact</p></div><ArrowUpRight size={22} className="text-teal-300" />
          </Link>
          <Link to="/actions" className="group flex items-center justify-between gap-4 p-5 transition-colors hover:bg-white/5 sm:p-6">
            <div><span className="text-3xl font-semibold tabular-nums">{stats ? pendingCtas : '—'}</span><p className="mt-1 font-medium">Open action items</p><p className="mt-1 text-xs text-slate-300">Review follow-ups and work in progress</p></div><ArrowUpRight size={22} className="text-teal-300" />
          </Link>
        </div>
      </div>
      <h3 className="mb-3 text-sm font-semibold text-ink">Workspace activity</h3>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {!stats || !analytics ? (
          Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <StatCard icon={Phone} label="Connected numbers" value={`${stats.connectedCount}/${stats.numberCount}`} />
            <StatCard
              icon={Bot}
              label="Active AI bots"
              value={scopedBots.filter((b) => b.connected && b.aiStatus === 'active').length}
              hint={`${scopedBots.filter((b) => b.aiStatus === 'testing').length} in testing`}
            />
            <StatCard icon={MessageSquare} label="Total conversations" value={stats.totalChats.toLocaleString('en-IN')} />
            <StatCard icon={Sparkles} label="AI replies · 14 days" value={totals.aiReplies.toLocaleString('en-IN')} />
          </>
        )}
      </div>

      {series && (
        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <Card>
            <h3 className="text-sm font-semibold text-ink">Conversation volume</h3>
            <p className="mb-4 text-xs text-ink-muted">Messages per day, last 14 days (IST)</p>
            <LineChart
              title="Conversation volume"
              series={[
                { key: 'inbound', label: 'Student messages', points: series.inbound },
                { key: 'ai', label: 'AI replies', points: series.aiReplies },
                { key: 'human', label: 'Human replies', points: series.humanReplies },
              ]}
            />
          </Card>
          <Card>
            <h3 className="text-sm font-semibold text-ink">Call-to-Actions</h3>
            <p className="mb-4 text-xs text-ink-muted">Created vs resolved per day</p>
            <LineChart
              title="Call-to-Actions"
              series={[
                { key: 'created', label: 'Created', points: series.actionsCreated },
                { key: 'resolved', label: 'Resolved', points: series.actionsResolved },
              ]}
            />
          </Card>
        </div>
      )}

      {analytics?.perNumber?.length > 0 && (
        <Card className="mt-6" padding={false}>
          <div className="flex items-center justify-between px-5 py-4">
            <h3 className="text-sm font-semibold text-ink">Numbers</h3>
            {isAdmin && <Link to="/bots" className="text-xs font-medium text-primary hover:underline">Manage AI bots</Link>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-y border-border bg-slate-50/80 text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-5 py-2.5 font-semibold">Number</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Chats</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Student msgs · 14d</th>
                  <th className="px-3 py-2.5 text-right font-semibold">AI replies</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Open CTAs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {analytics.perNumber.map((row) => {
                  const bot = scopedBots.find((b) => b.id === row.botId);
                  return (
                    <tr key={row.botId}>
                      <td className="px-5 py-3">
                        <p className="font-medium text-ink">{row.botName}</p>
                        <p className="text-xs text-ink-muted">{formatPhone(row.phone)}</p>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          <ConnectionBadge connected={bot?.connected} isActive={bot?.isActive !== false} />
                          <AiStatusBadge status={row.aiStatus} />
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.conversations}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.inbound}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.aiReplies}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.openActions}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </section>
  );
}

export default function Dashboard() {
  const { isOwner, user } = useAuth();
  return (
    <div className="mx-auto max-w-7xl">
      <SectionHeader title="Overview" subtitle={`Welcome back${user?.name ? `, ${user.name.split(' ')[0]}` : ''}.`} />
      <TeamOverview />
      {isOwner && <div className="mt-10 border-t border-border pt-8"><OwnerOverview /></div>}
    </div>
  );
}
