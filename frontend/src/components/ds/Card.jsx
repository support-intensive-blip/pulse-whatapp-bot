import React from 'react';
import { motion } from 'framer-motion';

export function Card({ children, className = '', hover = false, padding = true }) {
  const Comp = hover ? motion.div : 'div';
  const motionProps = hover
    ? {
        whileHover: { y: -2, boxShadow: '0 8px 24px rgba(17,24,39,0.08)' },
        transition: { duration: 0.15 },
      }
    : {};

  return (
    <Comp
      className={`rounded-xl border border-border bg-surface shadow-card ${padding ? 'p-5' : ''} ${className}`}
      {...motionProps}
    >
      {children}
    </Comp>
  );
}
