import React from 'react';

export function Input({ label, hint, className = '', ...props }) {
  return (
    <label className="block space-y-1.5">
      {label && <span className="text-sm font-medium text-ink">{label}</span>}
      {hint && <span className="block text-xs text-ink-muted">{hint}</span>}
      <input
        className={`h-11 w-full rounded-xl border border-border bg-white px-3 text-sm text-ink placeholder:text-ink-faint transition-colors duration-150 focus:border-primary focus:ring-2 focus:ring-primary/20 ${className}`}
        {...props}
      />
    </label>
  );
}

export function Textarea({ label, hint, className = '', rows = 4, ...props }) {
  return (
    <label className="block space-y-1.5">
      {label && <span className="text-sm font-medium text-ink">{label}</span>}
      {hint && <span className="block text-xs text-ink-muted">{hint}</span>}
      <textarea
        rows={rows}
        className={`w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint transition-colors duration-150 focus:border-primary focus:ring-2 focus:ring-primary/20 ${className}`}
        {...props}
      />
    </label>
  );
}

export function Select({ label, children, className = '', ...props }) {
  return (
    <label className="block space-y-1.5">
      {label && <span className="text-sm font-medium text-ink">{label}</span>}
      <select
        className={`h-11 w-full rounded-xl border border-border bg-white px-3 text-sm text-ink transition-colors duration-150 focus:border-primary focus:ring-2 focus:ring-primary/20 ${className}`}
        {...props}
      >
        {children}
      </select>
    </label>
  );
}
