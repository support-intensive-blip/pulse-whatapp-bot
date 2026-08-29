import React from 'react';

export function ActionItemSkeleton({ rows = 4 }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="p-5">
          <div className="flex gap-2">
            <div className="ds-skeleton h-5 w-16 rounded-md" />
            <div className="ds-skeleton h-5 w-20 rounded-md" />
          </div>
          <div className="ds-skeleton mt-3 h-5 w-2/3 max-w-md rounded-md" />
          <div className="ds-skeleton mt-2 h-4 w-1/2 max-w-xs rounded-md" />
        </div>
      ))}
    </div>
  );
}
