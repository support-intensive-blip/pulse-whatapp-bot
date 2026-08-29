import React from 'react';
import { Link } from 'react-router-dom';

const variants = {
  primary: 'bg-primary text-white hover:bg-primary-hover shadow-sm',
  secondary: 'bg-white text-ink border border-border hover:bg-slate-50',
  ghost: 'bg-transparent text-ink-muted hover:bg-slate-100 hover:text-ink',
  danger: 'bg-danger text-white hover:bg-red-600',
};

const sizes = {
  sm: 'h-9 px-3 text-xs',
  small: 'h-9 px-3 text-xs',
  md: 'h-11 px-4 text-sm',
  lg: 'h-11 px-5 text-sm font-medium',
};

export function Button({
  children,
  variant = 'primary',
  size = 'lg',
  className = '',
  type = 'button',
  ...props
}) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-xl transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function ButtonLink({ to, children, variant = 'primary', size = 'lg', className = '' }) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center justify-center gap-2 rounded-xl transition-all duration-150 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </Link>
  );
}
