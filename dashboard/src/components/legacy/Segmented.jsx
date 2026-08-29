import React from 'react';

export function Segmented({ value, onChange, options }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-xl border border-border bg-slate-50 p-1" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150 sm:text-sm ${
            value === opt.value ? 'bg-white text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
          }`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
