import React, { useEffect, useState } from 'react';
import { analyticsApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { AiStatusBadge, Alert, Card, SectionHeader, SoonTag, Spinner, Tabs, formatPhone } from '../components/ds';
import { LineChart } from '../components/charts/LineChart';

const RANGES = [
  { id: '7', label: '7 days' },
  { id: '14', label: '14 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
];

function Tile({ label, value, hint }) {
  return (
    <Card>
      <p className="text-sm text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
    </Card>
  );
}

export default function Analytics() {
  const { team, currentBot, scopeVersion } = useAuth();
  const [days, setDays] = useState('14');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    analyticsApi
      .get(Number(days))
      .then(setData)
      .catch((err) => setError(err.message));
  }, [days, scopeVersion]);

  const t = data?.totals;
  const replies = t ? t.aiReplies + t.humanReplies : 0;

  return (
    <div className="mx-auto max-w-7xl">
      <SectionHeader
        eyebrow={team?.name}
        title="Analytics"
        subtitle={`${currentBot ? currentBot.name : 'All numbers'} · from stored messages and Call-to-Actions (IST days).`}
        action={<Tabs value={days} onChange={setDays} tabs={RANGES} />}
      />
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}

      {!data ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Tile label="Student messages" value={t.inbound.toLocaleString('en-IN')} />
            <Tile label="AI replies" value={t.aiReplies.toLocaleString('en-IN')} hint={replies ? `${Math.round((t.aiReplies / replies) * 100)}% of replies` : null} />
            <Tile label="Human replies" value={t.humanReplies.toLocaleString('en-IN')} hint={replies ? `${Math.round((t.humanReplies / replies) * 100)}% of replies` : null} />
            <Tile label="Chats with AI off" value={t.chatsWithAiOff.toLocaleString('en-IN')} hint="Right now" />
            <Tile label="Actions created / resolved" value={`${t.actionsCreated} / ${t.actionsResolved}`} />
            <Tile label="Avg. resolution time" value={t.avgResolutionHours == null ? '—' : `${t.avgResolutionHours} h`} hint="Resolved actions in range" />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <h2 className="text-sm font-semibold text-ink">Conversation volume</h2>
              <p className="mb-4 text-xs text-ink-muted">Messages per day</p>
              <LineChart
                title="Conversation volume"
                series={[
                  { key: 'inbound', label: 'Student messages', points: data.series.inbound },
                  { key: 'ai', label: 'AI replies', points: data.series.aiReplies },
                  { key: 'human', label: 'Human replies', points: data.series.humanReplies },
                ]}
              />
            </Card>
            <Card>
              <h2 className="text-sm font-semibold text-ink">Active contacts</h2>
              <p className="mb-4 text-xs text-ink-muted">Contacts who sent at least one message that day</p>
              <LineChart title="Active contacts" series={[{ key: 'contacts', label: 'Active contacts', points: data.series.activeContacts }]} />
            </Card>
            <Card className="xl:col-span-2">
              <h2 className="text-sm font-semibold text-ink">Call-to-Actions</h2>
              <p className="mb-4 text-xs text-ink-muted">Created vs resolved per day</p>
              <LineChart
                title="Call-to-Actions"
                height={200}
                series={[
                  { key: 'created', label: 'Created', points: data.series.actionsCreated },
                  { key: 'resolved', label: 'Resolved', points: data.series.actionsResolved },
                ]}
              />
            </Card>
          </div>

          <Card padding={false}>
            <h2 className="px-5 py-4 text-sm font-semibold text-ink">Number comparison</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-y border-border bg-slate-50/80 text-xs uppercase tracking-wide text-ink-muted">
                  <tr>
                    <th className="px-5 py-2.5 font-semibold">Number</th>
                    <th className="px-3 py-2.5 font-semibold">AI status</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Chats</th>
                    <th className="px-3 py-2.5 text-right font-semibold">AI off</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Student msgs</th>
                    <th className="px-3 py-2.5 text-right font-semibold">AI replies</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Human replies</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Open CTAs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.perNumber.map((row) => (
                    <tr key={row.botId}>
                      <td className="px-5 py-3">
                        <p className="font-medium text-ink">{row.botName}</p>
                        <p className="text-xs text-ink-muted">{formatPhone(row.phone)}</p>
                      </td>
                      <td className="px-3 py-3"><AiStatusBadge status={row.aiStatus} /></td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.conversations}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.chatsWithAiOff}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.inbound}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.aiReplies}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.humanReplies}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.openActions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <p className="mb-2 text-sm font-semibold text-ink">Not tracked yet</p>
            <ul className="space-y-2">
              {data.unsupported.map((u) => (
                <li key={u.metric} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-ink">{u.metric}</span>
                  <SoonTag />
                  <span className="text-xs text-ink-muted">{u.reason}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}
