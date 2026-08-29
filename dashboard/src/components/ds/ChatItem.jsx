import React from 'react';

function avatarInitial(name) {
  const ch = (name || '?').trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

export function ChatItem({
  name,
  preview,
  time,
  active = false,
  selected = false,
  aiOn = false,
  showCheckbox = false,
  checked = false,
  onCheckboxChange,
  className = '',
  ...props
}) {
  return (
    <div
      className={`group flex cursor-pointer gap-3 border-b border-border/60 px-4 py-3 transition-colors duration-150 touch-manipulation select-none ${
        active
          ? 'bg-primary/5'
          : selected
            ? 'bg-emerald-50/80'
            : 'hover:bg-slate-50'
      } ${className}`}
      {...props}
    >
      {showCheckbox && (
        <label
          className="flex shrink-0 items-center pr-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onCheckboxChange?.(e.target.checked)}
            aria-label={`Select ${name}`}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary/30"
          />
        </label>
      )}
      <div className="relative shrink-0">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-sm font-semibold text-white shadow-sm">
          {avatarInitial(name)}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="truncate text-sm font-semibold text-ink">{name}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            {aiOn && (
              <span
                className="h-2.5 w-2.5 rounded-full bg-success shadow-[0_0_0_2px_#fff]"
                title="AI active"
                aria-label="AI active"
              />
            )}
            {time && (
              <time className="text-[11px] font-medium text-ink-muted">{time}</time>
            )}
          </div>
        </div>
        <p className="mt-0.5 truncate text-xs text-ink-muted">{preview}</p>
      </div>
    </div>
  );
}
