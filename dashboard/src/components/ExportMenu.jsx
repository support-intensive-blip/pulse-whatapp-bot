import React, { useEffect, useRef, useState } from 'react';

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    from: toLocalInputValue(from),
    to: toLocalInputValue(to),
  };
}

export default function ExportMenu({
  onExport,
  disabled = false,
  label = 'Export',
  compact = false,
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState(defaultRange);
  const [useRange, setUseRange] = useState(true);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function handleClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  async function handlePick(format) {
    setBusy(true);
    try {
      const payload = useRange
        ? {
            from: range.from ? new Date(range.from).toISOString() : undefined,
            to: range.to ? new Date(range.to).toISOString() : undefined,
          }
        : {};
      await onExport(format, payload);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`wa-export-menu${compact ? ' wa-export-menu-compact' : ''}`} ref={rootRef}>
      <button
        type="button"
        className={compact ? 'wa-icon-btn' : 'wa-sync-link'}
        disabled={disabled || busy}
        onClick={() => setOpen((v) => !v)}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {compact ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
        ) : (
          busy ? 'Exporting…' : label
        )}
      </button>
      {open && (
        <div className="wa-export-dropdown wa-export-panel" role="dialog" aria-label="Export conversations">
          <p className="wa-export-panel-title">Download conversations</p>
          <p className="wa-export-hint" style={{ marginBottom: '0.5rem' }}>
            Export is from Pulse storage (source of truth for past history). It does not change WhatsApp mobile or WhatsApp Web chat history.
          </p>
          <label className="wa-export-check">
            <input
              type="checkbox"
              checked={useRange}
              onChange={(e) => setUseRange(e.target.checked)}
            />
            Filter by date &amp; time range
          </label>
          <div className={`wa-export-range${useRange ? '' : ' is-disabled'}`}>
            <label>
              From
              <input
                type="datetime-local"
                value={range.from}
                disabled={!useRange}
                onChange={(e) => setRange((prev) => ({ ...prev, from: e.target.value }))}
              />
            </label>
            <label>
              To
              <input
                type="datetime-local"
                value={range.to}
                disabled={!useRange}
                onChange={(e) => setRange((prev) => ({ ...prev, to: e.target.value }))}
              />
            </label>
          </div>
          <p className="wa-export-hint">
            CSV includes contact name, incoming message, and bot message.
          </p>
          <div className="wa-export-actions">
            <button type="button" onClick={() => handlePick('csv')} disabled={busy}>
              {busy ? 'Exporting…' : 'Download CSV'}
            </button>
            <button type="button" className="is-secondary" onClick={() => handlePick('json')} disabled={busy}>
              JSON
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
