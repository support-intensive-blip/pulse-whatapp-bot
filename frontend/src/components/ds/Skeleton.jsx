import React from 'react';

export function Skeleton({ className = '' }) {
  return <div className={`ds-skeleton ${className}`} aria-hidden="true" />;
}

export function Spinner({ className = '' }) {
  return (
    <div
      className={`h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-primary ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}
