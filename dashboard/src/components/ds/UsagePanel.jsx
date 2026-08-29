import React from 'react';
import { Shield, Sparkles } from 'lucide-react';
import { Card } from './Card';
import { Badge } from './Badge';

const CATEGORY_LABELS = {
  chat: 'Chat replies',
  kb: 'Knowledge base',
  firewall: 'AI firewall',
  blocked: 'Blocked (saved)',
  action_trigger: 'Call to Action',
  context: 'Context',
  summary: 'Summaries',
  voice: 'Voice',
  pdf: 'PDF',
};

function formatTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

function formatUsd(n) {
  const value = Number(n) || 0;
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function UsagePanel({ tokenUsage = {} }) {
  const categories = tokenUsage.byCategory || [];
  const totalTokens = Number(tokenUsage.total_tokens) || 0;
  const estimatedCost = Number(tokenUsage.estimated_cost_usd) || 0;
  const efficiency = tokenUsage.efficiency || {};
  const blockedCount = efficiency.blockedCount || 0;
  const firewallCount = efficiency.firewallCount || 0;
  const savings = efficiency.estimatedSavingsUsd || 0;

  const sorted = [...categories].sort(
    (a, b) => Number(b.total_tokens) - Number(a.total_tokens)
  );

  return (
    <Card className="overflow-hidden !p-0">
      <div className="border-b border-border bg-gradient-to-r from-slate-50 to-primary-soft/40 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles size={18} className="text-primary" strokeWidth={1.75} />
              <h2 className="text-sm font-semibold text-ink">AI usage & efficiency</h2>
            </div>
            <p className="mt-1 text-sm text-ink-muted">
              Estimated at OpenAI gpt-4o-mini list rates (input $0.15/M, output $0.60/M).
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone="neutral">{formatTokens(totalTokens)} tokens</Badge>
            <Badge tone="neutral">{formatUsd(estimatedCost)} est. cost</Badge>
            {savings > 0 && (
              <Badge tone="live">{formatUsd(savings)} saved</Badge>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-5">
        <div className="border-b border-border p-5 lg:col-span-3 lg:border-b-0 lg:border-r">
          {sorted.length === 0 ? (
            <p className="text-sm text-ink-muted">No AI usage recorded yet.</p>
          ) : (
            <ul className="space-y-4">
              {sorted.map((row) => {
                const tokens = Number(row.total_tokens) || 0;
                const rowCost = Number(row.estimated_cost_usd) || 0;
                const pct = totalTokens > 0 ? Math.round((tokens / totalTokens) * 100) : 0;
                const label = CATEGORY_LABELS[row.category] || row.category;
                return (
                  <li key={row.category}>
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
                      <span className="font-medium text-ink">{label}</span>
                      <span className="text-ink-muted">
                        {formatTokens(tokens)}
                        {rowCost > 0 && <span className="ml-2">{formatUsd(rowCost)}</span>}
                        <span className="ml-2 text-xs">({row.request_count} calls)</span>
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-500"
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="p-5 lg:col-span-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Shield size={16} className="text-primary" />
            Firewall efficiency
          </div>
          <dl className="mt-4 space-y-3">
            <div className="flex items-center justify-between rounded-xl border border-border bg-slate-50 px-3 py-2.5">
              <dt className="text-sm text-ink-muted">Blocked at gate</dt>
              <dd className="text-sm font-semibold text-ink">{blockedCount}</dd>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border bg-slate-50 px-3 py-2.5">
              <dt className="text-sm text-ink-muted">Classifier calls</dt>
              <dd className="text-sm font-semibold text-ink">{firewallCount}</dd>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border bg-slate-50 px-3 py-2.5">
              <dt className="text-sm text-ink-muted">Est. savings</dt>
              <dd className="text-sm font-semibold text-success">{formatUsd(savings)}</dd>
            </div>
          </dl>
        </div>
      </div>
    </Card>
  );
}
