import React, { useEffect, useMemo, useState } from 'react';
import { usageApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  Alert,
  Card,
  EmptyState,
  SectionHeader,
  Select,
  Spinner,
  Table,
  TableBody,
  TableHead,
  Tabs,
  Td,
  Th,
  formatPhone,
} from '../components/ds';
import { LineChart } from '../components/charts/LineChart';
import { Coins } from 'lucide-react';

const ENVIRONMENTS = [
  { id: 'live', label: 'Live' },
  { id: 'test', label: 'Testing' },
];

const RANGES = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
  { id: 'all', label: 'All time' },
];

function formatTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString('en-IN');
}

function formatUsd(n) {
  const value = Number(n) || 0;
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function Tile({ label, value, hint }) {
  return (
    <Card>
      <p className="text-sm text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
    </Card>
  );
}

/** Every IST day in the window, so days without usage plot as 0. */
function fillDays(daily, days) {
  const byDay = new Map(daily.map((row) => [row.day, row]));
  const todayIst = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const first = days ? null : daily[0]?.day;
  const count = days || (first ? Math.round((Date.parse(todayIst) - Date.parse(first)) / 86400000) + 1 : 0);
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const day = new Date(Date.parse(todayIst) - i * 86400000).toISOString().slice(0, 10);
    out.push({ day, row: byDay.get(day) });
  }
  return out;
}

function UsageColumns() {
  return (
    <>
      <Th className="text-right">Input</Th>
      <Th className="text-right">Output</Th>
      <Th className="text-right">Total</Th>
      <Th className="text-right">Calls</Th>
      <Th className="text-right">Est. cost</Th>
    </>
  );
}

function UsageCells({ row }) {
  return (
    <>
      <Td className="text-right tabular-nums">{formatTokens(row.input_tokens)}</Td>
      <Td className="text-right tabular-nums">{formatTokens(row.output_tokens)}</Td>
      <Td className="text-right tabular-nums font-medium">{formatTokens(row.total_tokens)}</Td>
      <Td className="text-right tabular-nums">{Number(row.request_count).toLocaleString('en-IN')}</Td>
      <Td className="text-right tabular-nums">{formatUsd(row.estimated_cost_usd)}</Td>
    </>
  );
}

function ScrollTable({ children }) {
  return <div className="overflow-x-auto">{children}</div>;
}

export default function TokenUsage() {
  const { isOwner, team, teams, scopeVersion } = useAuth();
  const [range, setRange] = useState('30');
  const [teamFilter, setTeamFilter] = useState('all');
  const [env, setEnv] = useState('live');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    setError('');
    usageApi
      .tokens({ days: range === 'all' ? undefined : range, teamId: isOwner ? teamFilter : undefined, env })
      .then(setData)
      .catch((err) => setError(err.message));
  }, [range, teamFilter, env, isOwner, scopeVersion]);

  const series = useMemo(() => {
    if (!data?.daily?.length) return null;
    const filled = fillDays(data.daily, data.days);
    return [
      { key: 'input', label: 'Input tokens', points: filled.map(({ day, row }) => ({ day, value: Number(row?.input_tokens) || 0 })) },
      { key: 'output', label: 'Output tokens', points: filled.map(({ day, row }) => ({ day, value: Number(row?.output_tokens) || 0 })) },
    ];
  }, [data]);

  const t = data?.totals;
  const showTeams = isOwner && data?.scope === 'all';
  const scopeName = isOwner
    ? teamFilter === 'all'
      ? 'All teams'
      : teams.find((x) => String(x.id) === String(teamFilter))?.name
    : team?.name;

  return (
    <div className="mx-auto max-w-7xl">
      <SectionHeader
        eyebrow={scopeName}
        title="Token usage"
        subtitle="OpenAI input and output tokens per team and per WhatsApp number. Usage stays with the team the number belonged to when it was spent."
        action={<Tabs value={range} onChange={setRange} tabs={RANGES} />}
      />

      <div className="mb-4 flex flex-wrap items-end gap-4">
        {isOwner && (
          <div className="w-full max-w-xs">
            <Select label="Team" value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
              <option value="all">All teams</option>
              {teams.map((x) => (
                <option key={x.id} value={x.id}>{x.name}</option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={env} onChange={setEnv} tabs={ENVIRONMENTS} />
          {data?.byEnvironment && (
            <p className="text-xs text-ink-muted">
              Live {formatTokens(data.byEnvironment.live.total_tokens)} ({formatUsd(data.byEnvironment.live.estimated_cost_usd)})
              {' · '}Testing {formatTokens(data.byEnvironment.test.total_tokens)} ({formatUsd(data.byEnvironment.test.estimated_cost_usd)})
            </p>
          )}
        </div>
      </div>

      {error && <Alert tone="error" className="mb-4">{error}</Alert>}

      {!data && !error ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : data && !t.request_count ? (
        <EmptyState
          icon={Coins}
          title={`No ${env === 'test' ? 'testing' : 'live'} AI usage in this period`}
          description={env === 'test' ? "Testing usage comes from the playground and from each bot's test numbers." : 'Token usage appears here as soon as a bot answers a real student.'}
        />
      ) : data ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
            <Tile label="Input tokens" value={formatTokens(t.input_tokens)} hint="Prompt + context sent" />
            <Tile label="Output tokens" value={formatTokens(t.output_tokens)} hint="Generated by the model" />
            <Tile label="Total tokens" value={formatTokens(t.total_tokens)} />
            <Tile label="AI calls" value={Number(t.request_count).toLocaleString('en-IN')} />
            <Tile label="Estimated cost" value={formatUsd(t.estimated_cost_usd)} hint="From model list prices" />
          </div>

          {series && (
            <Card>
              <LineChart title="Daily tokens (IST)" valueLabel="Tokens" series={series} />
            </Card>
          )}

          {showTeams && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-ink">By team</h2>
              <ScrollTable>
                <Table>
                  <TableHead>
                    <Th>Team</Th>
                    <UsageColumns />
                  </TableHead>
                  <TableBody>
                    {data.byTeam.map((row) => (
                      <tr key={row.team_id ?? 'none'}>
                        <Td className="font-medium">{row.team_name || <span className="text-ink-muted">Unattributed</span>}</Td>
                        <UsageCells row={row} />
                      </tr>
                    ))}
                  </TableBody>
                </Table>
              </ScrollTable>
            </section>
          )}

          <section>
            <h2 className="mb-3 text-sm font-semibold text-ink">By WhatsApp number</h2>
            <ScrollTable>
              <Table>
                <TableHead>
                  <Th>Bot</Th>
                  {showTeams && <Th>Team</Th>}
                  <UsageColumns />
                </TableHead>
                <TableBody>
                  {data.byBot.map((row) => (
                    <tr key={`${row.bot_id ?? 'none'}-${row.team_id ?? 'none'}`}>
                      <Td>
                        {row.bot_id ? (
                          <>
                            <p className="font-medium">{row.bot_name}</p>
                            <p className="text-xs text-ink-muted">{formatPhone(row.bot_phone)}</p>
                          </>
                        ) : (
                          <span className="text-ink-muted">Unattributed</span>
                        )}
                      </Td>
                      {showTeams && <Td>{row.team_name || '—'}</Td>}
                      <UsageCells row={row} />
                    </tr>
                  ))}
                </TableBody>
              </Table>
            </ScrollTable>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <h2 className="mb-3 text-sm font-semibold text-ink">By model</h2>
              <ScrollTable>
                <Table>
                  <TableHead>
                    <Th>Model</Th>
                    <UsageColumns />
                  </TableHead>
                  <TableBody>
                    {data.byModel.map((row) => (
                      <tr key={row.model}>
                        <Td className="font-mono text-xs">{row.model}</Td>
                        <UsageCells row={row} />
                      </tr>
                    ))}
                  </TableBody>
                </Table>
              </ScrollTable>
            </section>
            <section>
              <h2 className="mb-3 text-sm font-semibold text-ink">By purpose</h2>
              <ScrollTable>
                <Table>
                  <TableHead>
                    <Th>Purpose</Th>
                    <UsageColumns />
                  </TableHead>
                  <TableBody>
                    {data.byCategory.map((row) => (
                      <tr key={row.category}>
                        <Td>{row.label}</Td>
                        <UsageCells row={row} />
                      </tr>
                    ))}
                  </TableBody>
                </Table>
              </ScrollTable>
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}
