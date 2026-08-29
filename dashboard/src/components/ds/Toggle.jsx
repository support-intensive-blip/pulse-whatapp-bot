import React from 'react';

export function Toggle({ checked, onChange, label, description, disabled = false }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-border bg-white p-4 transition-colors duration-150 hover:bg-slate-50">
      <div className="min-w-0 flex-1">
        {label && <p className="text-sm font-medium text-ink">{label}</p>}
        {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange?.(!checked)}
        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ${
          checked ? 'bg-success' : 'bg-slate-200'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <span
          className={`pointer-events-none block h-6 w-6 rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </label>
  );
}
