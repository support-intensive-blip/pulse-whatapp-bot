import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';

// Categorical slots in fixed order (validated: CVD ΔE ≥ 9.2, normal ≥ 27.6 on light).
// Slot 3 is below 3:1 contrast, so every chart ships a legend, direct end-labels
// and a table view — identity never rests on color alone.
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a'];

const MARGIN = { top: 12, right: 124, bottom: 28, left: 40 };

function niceMax(value) {
  if (value <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow * 4 >= value) * pow;
  return step * 4;
}

function shortDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * Daily time series, one shared y-axis. `series` = [{ key, label, points: [{ day, value }] }]
 * (≤ 3 series; colors follow series order). Hover / arrow keys move a crosshair.
 */
export function LineChart({ series, height = 240, valueLabel = 'Count', title }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState(null);
  const [showTable, setShowTable] = useState(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const update = () => setWidth(Math.max(280, el.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [showTable]);

  const days = series[0]?.points.map((p) => p.day) || [];
  const max = useMemo(
    () => niceMax(Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.value)))),
    [series]
  );

  // Narrow screens drop end-labels (legend + tooltip still carry identity).
  const compact = width < 480;
  const margin = { ...MARGIN, right: compact ? 12 : MARGIN.right };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const x = (i) => margin.left + (days.length <= 1 ? innerW / 2 : (i * innerW) / (days.length - 1));
  const y = (v) => margin.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(innerW / 64))));

  function indexFromEvent(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.round(((px - margin.left) / innerW) * (days.length - 1));
    return Math.max(0, Math.min(days.length - 1, i));
  }

  if (!days.length) return null;

  // Keep end-labels from colliding: nudge apart vertically.
  const endLabels = series
    .map((s, si) => ({ si, label: s.label, value: s.points[s.points.length - 1]?.value || 0 }))
    .map((l) => ({ ...l, y: y(l.value) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < endLabels.length; i += 1) {
    if (endLabels[i].y - endLabels[i - 1].y < 14) endLabels[i].y = endLabels[i - 1].y + 14;
  }

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5 text-xs text-ink-muted">
              <span className="h-0.5 w-4 rounded-full" style={{ background: SERIES_COLORS[i] }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="rounded-lg px-2 py-1 text-xs font-medium text-ink-muted hover:bg-slate-100 hover:text-ink"
          aria-pressed={showTable}
        >
          {showTable ? 'Chart' : 'Table'}
        </button>
      </div>

      {showTable ? (
        <div className="max-h-72 overflow-auto rounded-lg border border-border">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{title || valueLabel}</caption>
            <thead className="sticky top-0 bg-slate-50 text-ink-muted">
              <tr>
                <th className="px-3 py-2 font-semibold">Day</th>
                {series.map((s) => (
                  <th key={s.key} className="px-3 py-2 text-right font-semibold">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {days.map((day, i) => (
                <tr key={day}>
                  <td className="px-3 py-1.5 text-ink">{shortDay(day)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="px-3 py-1.5 text-right tabular-nums text-ink">{s.points[i]?.value ?? 0}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrapRef} className="relative">
          <svg
            width="100%"
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`${title || valueLabel}: ${series.map((s) => s.label).join(', ')} over ${days.length} days`}
            tabIndex={0}
            className="block outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            onMouseMove={(e) => setHover(indexFromEvent(e))}
            onMouseLeave={() => setHover(null)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') setHover((h) => Math.min(days.length - 1, (h ?? -1) + 1));
              if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? days.length) - 1));
              if (e.key === 'Escape') setHover(null);
            }}
            onBlur={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={margin.left} x2={width - margin.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#c3c2b7' : '#eceae4'} strokeWidth="1" />
                <text x={margin.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="#898781" className="tabular-nums">
                  {t}
                </text>
              </g>
            ))}
            {days.map((day, i) =>
              i % labelEvery === 0 || i === days.length - 1 ? (
                <text key={day} x={x(i)} y={height - 8} textAnchor="middle" fontSize="11" fill="#898781">
                  {shortDay(day)}
                </text>
              ) : null
            )}

            {hover != null && (
              <line x1={x(hover)} x2={x(hover)} y1={margin.top} y2={margin.top + innerH} stroke="#c3c2b7" strokeWidth="1" />
            )}

            {series.map((s, si) => (
              <polyline
                key={s.key}
                fill="none"
                stroke={SERIES_COLORS[si]}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={s.points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')}
              />
            ))}

            {hover != null &&
              series.map((s, si) => (
                <circle
                  key={s.key}
                  cx={x(hover)}
                  cy={y(s.points[hover]?.value || 0)}
                  r="4.5"
                  fill={SERIES_COLORS[si]}
                  stroke="#ffffff"
                  strokeWidth="2"
                />
              ))}

            {!compact &&
              endLabels.map((l) => (
                <text key={l.si} x={width - margin.right + 8} y={l.y} dy="0.32em" fontSize="11" fill="#52514e">
                  <tspan fill={SERIES_COLORS[l.si]} aria-hidden="true">● </tspan>
                  {l.label}
                </text>
              ))}
          </svg>

          {hover != null && (
            <div
              className="pointer-events-none absolute top-1 z-10 min-w-[9rem] rounded-lg border border-border bg-white px-3 py-2 text-xs shadow-lift"
              style={{
                left: Math.min(Math.max(0, (x(hover) / width) * 100), 100) + '%',
                transform: x(hover) > width * 0.6 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
              }}
            >
              <p className="mb-1 font-semibold text-ink">{shortDay(days[hover])}</p>
              {series.map((s, si) => (
                <p key={s.key} className="flex items-center justify-between gap-4 text-ink-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: SERIES_COLORS[si] }} />
                    {s.label}
                  </span>
                  <span className="font-semibold tabular-nums text-ink">{s.points[hover]?.value ?? 0}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
