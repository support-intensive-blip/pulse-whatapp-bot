import React from 'react';

export function Logo({ size = 36, className = '' }) {
  return (
    <img
      src="/pulse-logo.png"
      alt="Pulse"
      width={size}
      height={size}
      className={`object-contain ${className}`}
      draggable={false}
    />
  );
}
