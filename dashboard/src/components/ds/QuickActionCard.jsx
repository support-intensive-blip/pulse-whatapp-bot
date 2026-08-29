import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';

export function QuickActionCard({ to, state, icon: Icon, title, description }) {
  return (
    <motion.div whileHover={{ y: -2 }} transition={{ duration: 0.15 }}>
      <Link
        to={to}
        state={state}
        className="group flex h-full flex-col rounded-xl border border-border bg-surface p-5 shadow-card transition-all duration-150 hover:border-primary/30 hover:shadow-lift"
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-ink transition-colors duration-150 group-hover:bg-primary-soft group-hover:text-primary">
          {Icon && <Icon size={20} strokeWidth={1.75} />}
        </div>
        <h3 className="mt-4 text-sm font-semibold text-ink">{title}</h3>
        <p className="mt-1 flex-1 text-sm text-ink-muted">{description}</p>
        <ChevronRight
          size={16}
          className="mt-4 text-ink-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-primary"
        />
      </Link>
    </motion.div>
  );
}
