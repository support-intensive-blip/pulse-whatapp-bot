import React from 'react';

function initialsFromName(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return 'P';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function UserAvatar({ name, size = 'md', className = '' }) {
  const label = initialsFromName(name);
  const sizeClass =
    size === 'sm' ? 'h-8 w-8 text-xs' : size === 'lg' ? 'h-11 w-11 text-sm' : 'h-9 w-9 text-xs';

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-hover font-semibold text-white shadow-sm ${sizeClass} ${className}`}
      aria-hidden
    >
      {label}
    </span>
  );
}
