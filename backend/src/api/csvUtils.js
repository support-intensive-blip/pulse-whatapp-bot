function parseCsvRows(csvText) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const text = `${String(csvText || '').replace(/^﻿/, '')}\n`;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(field);
      field = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i += 1;
      if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += ch;
    }
  }

  return rows;
}

function parseActiveFlag(value, fallback = true) {
  if (value == null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'enable', 'enabled'].includes(v)) return true;
  if (['false', '0', 'no', 'off', 'disable', 'disabled'].includes(v)) return false;
  return fallback;
}

/** Rows with headers lower-cased; empty rows dropped. */
function parseCsvTable(csvText) {
  const rows = parseCsvRows(csvText).filter((r) => r.some((c) => String(c || '').trim()));
  if (!rows.length) return { headers: [], rows: [] };
  return {
    headers: rows[0].map((h) => String(h || '').trim()),
    rows: rows.slice(1),
  };
}

function parseCsvMessages(csvText) {
  const rows = parseCsvRows(csvText).filter((r) => r.some((c) => String(c || '').trim()));
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const getIndex = (names) => headers.findIndex((h) => names.includes(h));

  const idxContactName = getIndex(['contact_name', 'contactname', 'name']);
  const idxContactPhone = getIndex(['contact_phone', 'contactphone', 'phone']);
  const idxRole = getIndex(['role']);
  const idxContent = getIndex(['content', 'message', 'text']);
  const idxTimestamp = getIndex(['timestamp', 'time', 'created_at']);
  const idxEnableAi = getIndex(['enable_ai', 'enableai', 'ai', 'active']);

  if (idxContent < 0) return [];

  return rows.slice(1).map((r) => ({
    contactName: idxContactName >= 0 ? String(r[idxContactName] || '').trim() : '',
    contactPhone: idxContactPhone >= 0 ? String(r[idxContactPhone] || '').trim() : '',
    role: idxRole >= 0 ? String(r[idxRole] || '').trim().toLowerCase() : 'user',
    content: String(r[idxContent] || '').trim(),
    timestamp: idxTimestamp >= 0 ? String(r[idxTimestamp] || '').trim() : '',
    enableAi: idxEnableAi >= 0 ? parseActiveFlag(r[idxEnableAi], null) : null,
  }));
}

function parseCsvAiBulk(csvText) {
  const rows = parseCsvRows(csvText).filter((r) => r.some((c) => String(c || '').trim()));
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const getIndex = (names) => headers.findIndex((h) => names.includes(h));
  const idxName = getIndex(['contact_name', 'contactname', 'name']);
  const idxActive = getIndex(['active', 'enable_ai', 'enableai', 'ai']);

  if (idxName < 0) return [];

  return rows
    .slice(1)
    .map((r) => ({
      name: String(r[idxName] || '').trim(),
      active: idxActive >= 0 ? parseActiveFlag(r[idxActive], null) : null,
    }))
    .filter((row) => row.name);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

module.exports = {
  parseCsvRows,
  parseCsvTable,
  parseActiveFlag,
  parseCsvMessages,
  parseCsvAiBulk,
  csvCell,
};
