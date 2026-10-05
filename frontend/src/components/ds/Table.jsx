import React from 'react';

export function Table({ children, className = '' }) {
  return (
    <div className={`overflow-hidden rounded-xl border border-border bg-white shadow-card ${className}`}>
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  );
}

export function TableHead({ children }) {
  return (
    <thead className="border-b border-border bg-slate-50/80">
      <tr>{children}</tr>
    </thead>
  );
}

export function TableBody({ children }) {
  return <tbody className="divide-y divide-border">{children}</tbody>;
}

export function Th({ children, className = '' }) {
  return (
    <th
      className={`px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-muted ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, className = '' }) {
  return <td className={`px-4 py-4 align-middle text-ink ${className}`}>{children}</td>;
}
