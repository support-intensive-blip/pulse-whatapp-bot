import React from 'react';

export function Tabs({ value, onChange, tabs, className = '' }) {
  return (
    <div
      className={`inline-flex flex-wrap gap-1 rounded-xl border border-border bg-slate-50 p-1 ${className}`}
      role="tablist"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={`rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150 ${
            value === tab.id
              ? 'bg-white text-ink shadow-sm'
              : 'text-ink-muted hover:text-ink'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
