import React from 'react';

export function PageSection({ title, description, action, children, className = '' }) {
  return (
    <section className={`${className}`}>
      {(title || description || action) && (
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
