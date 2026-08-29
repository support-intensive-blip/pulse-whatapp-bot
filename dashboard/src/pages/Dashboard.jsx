import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Wifi,
  MessageSquare,
  MessagesSquare,
  Bot,
  DollarSign,
  Smartphone,
  Settings2,
  Users,
  MessageCircle,
  Activity,
  Zap,
  ArrowRight,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { dataApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  SectionHeader,
  StatCard,
  StatCardSkeleton,
  QuickActionCard,
  Card,
  Badge,
  ButtonLink,
  EmptyState,
  PageSection,
  UsagePanel,
} from '../components/ds';
import { useActionItemsFeed } from '../hooks/useActionItemsFeed';

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function pendingFromActionRows(rows = []) {
  return rows.find((r) => r.status === 'pending')?.count || 0;
}

export default function Dashboard() {
  const { user, bot } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const { pendingCount } = useActionItemsFeed();

  useEffect(() => {
    let cancelled = false;

    function loadStats() {
      dataApi
        .stats(true)
        .then((data) => {
          if (!cancelled) setStats(data);
        })
        .catch(() => {});
    }

    const fallbackTimer = setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, 10000);

    dataApi
      .stats(true)
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      })
      .finally(() => {
        if (!cancelled) {
          clearTimeout(fallbackTimer);
          setLoading(false);
        }
      });

    const interval = setInterval(loadStats, 15000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadStats();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const isLive = bot?.status === 'ready';
  const tokenUsage = stats?.tokenUsage || {};
  const totalTokens = tokenUsage.total_tokens ?? 0;
  const estimatedCost = Number(tokenUsage.estimated_cost_usd ?? 0);
  const costPerMillion =
    totalTokens > 0 ? ((estimatedCost / totalTokens) * 1_000_000).toFixed(2) : '0.00';
  const blockedSavings = Number(tokenUsage.efficiency?.estimatedSavingsUsd ?? 0);
  const ctaPending = pendingCount || pendingFromActionRows(stats?.actionItems);

  const statsScope = stats?.scope || 'self';
  const scopeLabel =
    statsScope === 'all_teams'
      ? 'All teams'
      : statsScope === 'team'
        ? 'Your team'
        : 'Your workspace';

  const dashboardSubtitle = isLive
    ? 'Monitor conversations, AI usage, and follow-ups from a single workspace.'
    : 'Connect WhatsApp Business to activate AI replies, knowledge base, and coach alerts.';

  return (
    <div className="mx-auto max-w-7xl">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        <SectionHeader
          eyebrow={`Good ${getGreeting()}, ${user?.name?.split(' ')[0] || 'there'}`}
          title={isLive ? 'Operations overview' : 'Get started with Pulse'}
          subtitle={dashboardSubtitle}
          action={
            !isLive ? (
              <ButtonLink to="/connect" variant="primary">
                <Smartphone size={18} />
                Connect WhatsApp
              </ButtonLink>
            ) : (
              <div className="flex items-center gap-2">
                <Badge tone="neutral">{scopeLabel}</Badge>
                <Badge tone="live" dot>
                  Connected
                </Badge>
              </div>
            )
          }
        />

        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <StatCardSkeleton key={i} />
            ))}
          </div>
        ) : (
          <>
            <PageSection title="Today at a glance" className="mb-8">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  icon={Wifi}
                  label="Connection"
                  value={isLive ? 'Online' : 'Offline'}
                  hint={isLive ? 'WhatsApp linked' : 'Link required'}
                />
                <StatCard
                  icon={MessageSquare}
                  label="Messages today"
                  value={(stats?.messagesToday ?? 0).toLocaleString()}
                />
                <StatCard
                  icon={MessagesSquare}
                  label="Active chats"
                  value={stats?.activeChats ?? 0}
                />
                <StatCard
                  icon={Bot}
                  label="AI responses"
                  value={(stats?.aiResponses ?? 0).toLocaleString()}
                />
                <StatCard
                  icon={Zap}
                  label="Pending CTAs"
                  value={ctaPending}
                  hint="Requires coach follow-up"
                />
                <StatCard
                  icon={DollarSign}
                  label="Est. AI cost"
                  value={`$${estimatedCost.toFixed(estimatedCost > 0 && estimatedCost < 0.01 ? 4 : 2)}`}
                  hint={`${totalTokens.toLocaleString()} tokens · ~$${costPerMillion}/1M`}
                />
                {blockedSavings > 0 && (
                  <StatCard
                    icon={DollarSign}
                    label="Firewall savings"
                    value={`$${blockedSavings.toFixed(2)}`}
                    hint="Blocked before main LLM"
                  />
                )}
              </div>
            </PageSection>

            {isLive || totalTokens > 0 ? (
              <PageSection title="Usage & guardrails" className="mb-8">
                <UsagePanel tokenUsage={tokenUsage} />
              </PageSection>
            ) : null}

            <PageSection title="Shortcuts" className="mb-8">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <QuickActionCard
                  to="/connect"
                  icon={Smartphone}
                  title="Connect WhatsApp"
                  description="Link via QR or pairing code."
                />
                <QuickActionCard
                  to="/settings"
                  icon={Settings2}
                  title="Bot settings"
                  description="Assistant name and reply toggles."
                />
                <QuickActionCard
                  to="/conversations"
                  icon={Users}
                  title="Contacts & chats"
                  description="Per-contact assistant controls."
                />
                <QuickActionCard
                  to="/conversations"
                  icon={MessageCircle}
                  title="Conversations"
                  description="Read and monitor WhatsApp threads."
                />
                <QuickActionCard
                  to="/actions"
                  icon={Activity}
                  title="Call to Action"
                  description="Escalations and coach queue."
                />
              </div>
            </PageSection>

            <PageSection
              title="Coach queue"
              description="Latest call-to-action volume by status."
              action={
                ctaPending > 0 ? (
                  <Link
                    to="/actions"
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    View queue
                    <ArrowRight size={14} />
                  </Link>
                ) : null
              }
            >
              <Card>
                {!stats?.actionItems?.length ? (
                  <EmptyState
                    icon={Activity}
                    title="No escalations yet"
                    description="CTAs appear when triggers match inbound student messages."
                    action={
                      <ButtonLink to="/actions" variant="secondary" size="md">
                        Open Call to Action
                      </ButtonLink>
                    }
                  />
                ) : (
                  <ul className="divide-y divide-border">
                    {stats.actionItems.map((row) => (
                      <li
                        key={row.status}
                        className="flex items-center justify-between px-5 py-4 first:pt-0 last:pb-0"
                      >
                        <span className="text-sm capitalize text-ink-muted">{row.status}</span>
                        <span className="text-lg font-semibold tabular-nums text-ink">{row.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </PageSection>
          </>
        )}

        {!loading && !isLive && (
          <div className="mt-6">
            <EmptyState
              icon={MessageSquare}
              title="WhatsApp not connected"
              description="Link your business number to start receiving AI-assisted conversations."
              action={
                <ButtonLink to="/connect" variant="primary">
                  Connect now
                </ButtonLink>
              }
            />
          </div>
        )}
      </motion.div>
    </div>
  );
}
