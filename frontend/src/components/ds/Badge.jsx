import React from 'react';

const tones = {
  neutral: 'bg-slate-100 text-ink-muted',
  primary: 'bg-primary-soft text-primary',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-700',
  live: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
};

export function Badge({ children, tone = 'neutral', dot = false, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${tones[tone] || tones.neutral} ${className}`}
    >
      {dot && (
        <span
          className={`h-1.5 w-1.5 rounded-full ${tone === 'live' || tone === 'success' ? 'bg-success' : 'bg-current'}`}
        />
      )}
      {children}
    </span>
  );
}
