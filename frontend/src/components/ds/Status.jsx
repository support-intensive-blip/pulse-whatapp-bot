import React from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { Badge } from './Badge';

const AI_STATUS = {
  active: { tone: 'ai', label: 'AI Active' },
  testing: { tone: 'warning', label: 'Testing' },
  paused: { tone: 'neutral', label: 'AI Paused' },
};

export function AiStatusBadge({ status, className = '' }) {
  const meta = AI_STATUS[status] || AI_STATUS.paused;
  if (meta.tone === 'ai') {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full bg-ai-soft px-2.5 py-1 text-xs font-medium text-ai ring-1 ring-ai-ring ${className}`}>
        <span className="h-1.5 w-1.5 rounded-full bg-ai" />
        {meta.label}
      </span>
    );
  }
  return (
    <Badge tone={meta.tone} dot className={className}>
      {meta.label}
    </Badge>
  );
}

/** Gallabox connection: running / not configured / stopped. */
export function ConnectionBadge({ connected, configured = true, isActive = true, className = '' }) {
  if (!isActive) return <Badge tone="neutral" className={className}>Deactivated</Badge>;
  if (!configured) return <Badge tone="warning" dot className={className}>Not configured</Badge>;
  return connected ? (
    <Badge tone="live" dot className={className}>Connected</Badge>
  ) : (
    <Badge tone="danger" dot className={className}>Disconnected</Badge>
  );
}

export function formatPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return digits ? `+${digits}` : '';
}

/** Which WhatsApp number a chat / item belongs to (shown in "All Numbers" views). */
export function NumberBadge({ name, phone, className = '' }) {
  if (!name && !phone) return null;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-md bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold text-primary ${className}`}
      title={phone ? formatPhone(phone) : undefined}
    >
      {name || formatPhone(phone)}
    </span>
  );
}

const ALERT_TONES = {
  info: { cls: 'border-sky-200 bg-sky-50 text-sky-900', Icon: Info },
  success: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-800', Icon: CheckCircle2 },
  warning: { cls: 'border-amber-200 bg-amber-50 text-amber-900', Icon: AlertTriangle },
  error: { cls: 'border-red-200 bg-red-50 text-red-800', Icon: XCircle },
};

export function Alert({ tone = 'info', children, onDismiss, className = '' }) {
  if (!children) return null;
  const { cls, Icon } = ALERT_TONES[tone] || ALERT_TONES.info;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm ${cls} ${className}`}>
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="-my-0.5 rounded px-1 text-base leading-none opacity-60 hover:opacity-100" aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

/** Small "Coming soon" marker for features the backend doesn't support yet. */
export function SoonTag({ className = '' }) {
  return (
    <span className={`rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint ${className}`}>
      Coming soon
    </span>
  );
}
