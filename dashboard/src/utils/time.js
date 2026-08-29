const IST = 'Asia/Kolkata';

export function parseTimestamp(ts) {
  if (!ts) return null;
  const raw = String(ts).trim();
  if (!raw) return null;
  if (raw.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  // SQLite datetime('now') and legacy rows are stored as UTC without a suffix.
  const d = new Date(`${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatISTTime(ts) {
  const d = parseTimestamp(ts);
  if (!d) return '';
  return d.toLocaleTimeString('en-IN', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatISTDate(ts) {
  const d = parseTimestamp(ts);
  if (!d) return '';
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: IST }));
  const istMsg = new Date(d.toLocaleString('en-US', { timeZone: IST }));
  if (istMsg.toDateString() === istNow.toDateString()) {
    return formatISTTime(ts);
  }
  return d.toLocaleDateString('en-IN', {
    timeZone: IST,
    month: 'short',
    day: 'numeric',
  });
}

export function formatISTDateTime(ts) {
  const d = parseTimestamp(ts);
  if (!d) return '';
  return d.toLocaleString('en-IN', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}
