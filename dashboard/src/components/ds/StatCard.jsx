import React from 'react';
import { motion } from 'framer-motion';
import { Card } from './Card';

export function StatCard({ icon: Icon, label, value, trend, trendUp = true, hint, className = '' }) {
  return (
    <Card className={className} hover>
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-soft text-primary">
          {Icon && <Icon size={20} strokeWidth={1.75} />}
        </div>
        {trend != null && (
          <span
            className={`text-xs font-medium ${trendUp ? 'text-success' : 'text-danger'}`}
          >
            {trendUp ? '+' : ''}
            {trend}%
          </span>
        )}
      </div>
      <p className="mt-4 text-3xl font-semibold tracking-tight text-ink">{value}</p>
      <p className="mt-1 text-sm text-ink-muted">{label}</p>
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </Card>
  );
}

export function StatCardSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-surface p-5 shadow-card">
      <div className="ds-skeleton h-10 w-10 rounded-xl" />
      <div className="ds-skeleton mt-4 h-8 w-24 rounded-lg" />
      <div className="ds-skeleton mt-2 h-4 w-32 rounded-md" />
    </div>
  );
}
