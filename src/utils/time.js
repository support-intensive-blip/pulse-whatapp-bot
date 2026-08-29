const IST = 'Asia/Kolkata';

function parseTimestamp(ts) {
  if (!ts) return null;
  const raw = String(ts).trim();
  if (!raw) return null;
  if (raw.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const d = new Date(`${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatISTDateTime(ts) {
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

/** Current wall-clock time in IST, formatted for the LLM's current_date_time context —
 *  computed fresh at call time so it reflects when the message is actually sent to the model,
 *  not when it was received (batching/queueing can delay that by several seconds). */
function currentISTDateTimeForLLM() {
  const now = new Date();
  const weekday = now.toLocaleDateString('en-IN', { timeZone: IST, weekday: 'long' });
  const datePart = now.toLocaleDateString('en-IN', {
    timeZone: IST,
    year: 'numeric',
    month: 'long',
    day: '2-digit',
  });
  const timePart = now.toLocaleTimeString('en-IN', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return `${weekday}, ${datePart}, ${timePart} IST`;
}

module.exports = { parseTimestamp, formatISTDateTime, currentISTDateTimeForLLM };
