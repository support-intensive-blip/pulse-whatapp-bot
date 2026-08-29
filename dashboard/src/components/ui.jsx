export {
  Button,
  ButtonLink,
  Card,
  Badge,
  Input,
  Textarea,
  Select,
  SectionHeader,
  StatCard,
  StatCardSkeleton,
  QuickActionCard,
  Tabs,
  EmptyState,
  Toggle,
  Skeleton,
  Spinner,
  Table,
  TableHead,
  TableBody,
  Th,
  Td,
} from './ds';

export { SectionHeader as PageHeader } from './ds/SectionHeader';
export { EmptyState as EmptyStateBlock } from './ds/EmptyState';

import React from 'react';
import { Segmented as LegacySegmented } from './legacy/Segmented';

export function Segmented(props) {
  return <LegacySegmented {...props} />;
}

export function StatusDot({ status }) {
  const live = status === 'ready';
  return (
    <span
      className={`relative inline-flex h-2.5 w-2.5 rounded-full ${live ? 'bg-success' : 'bg-slate-300'}`}
      title={status || 'offline'}
    >
      {live && (
        <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-40" />
      )}
    </span>
  );
}

export function Stat({ label, value, highlight }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${highlight ? 'text-success' : 'text-ink'}`}>{value}</p>
    </div>
  );
}
