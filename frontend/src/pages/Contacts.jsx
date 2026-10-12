import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Contact, Download, Search, Upload, Wrench } from 'lucide-react';
import { contactsApi, usersApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import ContactsPanel from '../components/ContactsPanel';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Modal,
  NumberBadge,
  SectionHeader,
  Select,
  Spinner,
  Toggle,
} from '../components/ds';
import { formatISTDate } from '../utils/time';

const FIELDS = [
  { id: 'phone', label: 'Phone', required: true },
  { id: 'name', label: 'Name' },
  { id: 'tags', label: 'Tags (separate with ;)' },
  { id: 'notes', label: 'Notes' },
];

const ROW_STATUS = {
  new: { tone: 'success', label: 'New' },
  existing: { tone: 'primary', label: 'Existing chat' },
  duplicate: { tone: 'warning', label: 'Duplicate' },
  invalid: { tone: 'danger', label: 'Invalid' },
};

function ImportWizard({ open, onClose, onImported }) {
  const { bots, currentBotId } = useAuth();
  const [step, setStep] = useState(0);
  const [botId, setBotId] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [enableAi, setEnableAi] = useState(true);
  const [updateExisting, setUpdateExisting] = useState(true);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setBotId(currentBotId || bots[0]?.id || '');
    setFile(null);
    setPreview(null);
    setMapping(null);
    setResult(null);
    setError('');
  }, [open, currentBotId, bots]);

  async function runPreview(nextMapping = mapping) {
    setBusy(true);
    setError('');
    try {
      const data = await contactsApi.importPreview({ file, botId, mapping: nextMapping });
      setPreview(data);
      setMapping(data.mapping);
      setStep(1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError('');
    try {
      setResult(await contactsApi.importCommit({ file, botId, mapping, enableAi, updateExisting }));
      setStep(2);
      onImported();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const s = preview?.summary;
  const importable = s ? s.new + (updateExisting ? s.existing : 0) : 0;
  const bot = bots.find((b) => b.id === Number(botId));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import contacts from CSV"
      subtitle={['Choose number & file', 'Map columns & review', 'Done'][step]}
      size="xl"
      footer={
        step === 0 ? (
          <>
            <Button variant="secondary" size="md" onClick={() => contactsApi.downloadTemplate()}>
              <Download size={14} /> Template
            </Button>
            <Button size="md" onClick={() => runPreview(null)} disabled={!file || !botId || busy}>{busy ? 'Reading…' : 'Continue'}</Button>
          </>
        ) : step === 1 ? (
          <>
            <Button variant="secondary" size="md" onClick={() => setStep(0)} disabled={busy}>Back</Button>
            <Button size="md" onClick={commit} disabled={busy || !importable}>
              {busy ? 'Importing…' : `Import ${importable} contact${importable === 1 ? '' : 's'}`}
            </Button>
          </>
        ) : (
          <Button size="md" onClick={onClose}>Done</Button>
        )
      }
    >
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}

      {step === 0 && (
        <div className="space-y-4">
          <Select label="WhatsApp number these contacts belong to" value={botId} onChange={(e) => setBotId(e.target.value)}>
            {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <p className="text-xs text-ink-muted">Contacts are kept per number — importing into one number never merges them with another number's chats.</p>
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-10 text-center hover:bg-slate-50">
            <Upload size={22} className="text-ink-muted" />
            <span className="text-sm font-medium text-ink">{file ? file.name : 'Choose a .csv file'}</span>
            <span className="text-xs text-ink-muted">Columns like name, phone, tags, notes — you can map them next</span>
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
        </div>
      )}

      {step === 1 && preview && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-4">
            {FIELDS.map((f) => (
              <Select
                key={f.id}
                label={`${f.label}${f.required ? ' *' : ''}`}
                value={mapping?.[f.id] || ''}
                onChange={(e) => {
                  const next = { ...mapping, [f.id]: e.target.value || null };
                  setMapping(next);
                  runPreview(next);
                }}
              >
                <option value="">— not imported —</option>
                {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </Select>
            ))}
          </div>

          <div className="flex flex-wrap gap-2 text-sm">
            <Badge tone="success">{s.new} new</Badge>
            <Badge tone="primary">{s.existing} already chatting on {bot?.name}</Badge>
            <Badge tone="warning">{s.duplicate} duplicates in file</Badge>
            <Badge tone="danger">{s.invalid} invalid</Badge>
            <span className="text-ink-muted">of {s.total} rows</span>
          </div>

          <div className="max-h-72 overflow-auto rounded-xl border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-ink-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">Row</th>
                  <th className="px-3 py-2 font-semibold">Name</th>
                  <th className="px-3 py-2 font-semibold">Phone</th>
                  <th className="px-3 py-2 font-semibold">Tags</th>
                  <th className="px-3 py-2 font-semibold">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {preview.rows.map((r) => (
                  <tr key={r.rowNumber}>
                    <td className="px-3 py-1.5 text-ink-muted">{r.rowNumber}</td>
                    <td className="px-3 py-1.5 text-ink">{r.name || '—'}</td>
                    <td className="px-3 py-1.5 font-mono text-ink">{r.phone || r.rawPhone || '—'}</td>
                    <td className="px-3 py-1.5 text-ink-muted">{r.tags.join(', ')}</td>
                    <td className="px-3 py-1.5">
                      <Badge tone={ROW_STATUS[r.status].tone}>{ROW_STATUS[r.status].label}</Badge>
                      {r.error && <span className="ml-1.5 text-red-700">{r.error}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.summary.total > preview.rows.length && <p className="text-xs text-ink-muted">Showing the first {preview.rows.length} rows.</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            <Toggle checked={enableAi} onChange={setEnableAi} label="AI on for new contacts" description="Off = they wait for a human when they message." />
            <Toggle checked={updateExisting} onChange={setUpdateExisting} label="Update existing chats" description="Adds tags and notes to contacts already chatting on this number." />
          </div>
        </div>
      )}

      {step === 2 && result && (
        <div className="space-y-4">
          <Alert tone="success">
            {result.created} contact{result.created === 1 ? '' : 's'} added, {result.updated} updated, {result.skipped} skipped.
          </Alert>
          {result.errors.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-semibold text-ink">Skipped rows</p>
              <ul className="max-h-60 space-y-1 overflow-auto text-xs text-ink-muted">
                {result.errors.map((e) => <li key={e.rowNumber}>Row {e.rowNumber}: {e.error}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function Contacts() {
  const navigate = useNavigate();
  const { bots, currentBotId, isAdmin, scopeVersion } = useAuth();
  const [filters, setFilters] = useState({ search: '', tag: '', assigned: '', source: '' });
  const [data, setData] = useState(null);
  const [members, setMembers] = useState([]);
  const [importing, setImporting] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await contactsApi.list(filters));
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    }
  }, [filters]);

  useEffect(() => {
    const t = setTimeout(load, filters.search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, scopeVersion]);

  useEffect(() => {
    usersApi.members().then((d) => setMembers(d.members)).catch(() => {});
  }, [scopeVersion]);

  const setFilter = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const filterSelect = 'h-10 rounded-xl border border-border bg-white px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';
  const memberName = (id) => members.find((m) => m.id === id)?.name;

  return (
    <div className="mx-auto max-w-7xl">
      <SectionHeader
        title="Contacts"
        subtitle="People who have chatted with or been imported into your numbers. The same person on two numbers is two separate contacts."
        action={
          <div className="flex flex-wrap gap-2">
            {isAdmin && (
              <Button variant="secondary" onClick={() => setBulkOpen(true)} disabled={!bots.length}>
                <Wrench size={16} /> Bulk tools
              </Button>
            )}
            <Button variant="secondary" onClick={() => contactsApi.exportCsv(filters).catch((err) => setMessage({ tone: 'error', text: err.message }))}>
              <Download size={16} /> Export
            </Button>
            <Button onClick={() => setImporting(true)} disabled={!bots.length}>
              <Upload size={16} /> Import CSV
            </Button>
          </div>
        }
      />
      {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)} className="mb-4">{message.text}</Alert>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input type="search" value={filters.search} onChange={setFilter('search')} placeholder="Search name or phone…" aria-label="Search contacts" className={`${filterSelect} w-full pl-9`} />
        </div>
        <select aria-label="Tag" value={filters.tag} onChange={setFilter('tag')} className={filterSelect}>
          <option value="">Any tag</option>
          {(data?.tags || []).map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select aria-label="Assigned" value={filters.assigned} onChange={setFilter('assigned')} className={filterSelect}>
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select aria-label="Source" value={filters.source} onChange={setFilter('source')} className={filterSelect}>
          <option value="">Any source</option>
          <option value="whatsapp">Messaged us</option>
          <option value="csv">CSV import</option>
        </select>
        {data && <span className="ml-auto text-sm text-ink-muted">{data.count.toLocaleString('en-IN')} contacts</span>}
      </div>

      {!data ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !data.contacts.length ? (
        <EmptyState
          icon={Contact}
          title="No contacts"
          description={bots.length ? 'Contacts appear when people message your numbers, or import them from a CSV.' : 'Connect a WhatsApp number first.'}
          action={bots.length ? <Button onClick={() => setImporting(true)}>Import CSV</Button> : null}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-white shadow-card">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-border bg-slate-50/80 text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Contact</th>
                <th className="px-4 py-3 font-semibold">Number</th>
                <th className="px-4 py-3 font-semibold">Tags</th>
                <th className="px-4 py-3 font-semibold">Assigned</th>
                <th className="px-4 py-3 font-semibold">AI</th>
                <th className="px-4 py-3 text-right font-semibold">Open CTAs</th>
                <th className="px-4 py-3 font-semibold">Last interaction</th>
                <th className="px-4 py-3 font-semibold">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.contacts.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/conversations/${c.id}`)}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-ink">{c.contactName}</p>
                    <p className="text-xs text-ink-muted">{c.contactPhone || '—'}</p>
                  </td>
                  <td className="px-4 py-3"><NumberBadge name={c.botName} phone={c.botPhone} /></td>
                  <td className="px-4 py-3">
                    <div className="flex max-w-[14rem] flex-wrap gap-1">
                      {c.tags.length ? c.tags.map((t) => <Badge key={t} tone="neutral">{t}</Badge>) : <span className="text-ink-faint">—</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-ink">{memberName(c.assignedUserId) || <span className="text-ink-faint">—</span>}</td>
                  <td className="px-4 py-3">{c.aiOn ? <Badge tone="success" dot>On</Badge> : <Badge tone="neutral">Off</Badge>}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.openActionItems || '—'}</td>
                  <td className="px-4 py-3 text-ink-muted">{c.messageCount ? formatISTDate(c.updatedAt) : 'Never messaged'}</td>
                  <td className="px-4 py-3 text-xs text-ink-muted">{c.importSource ? c.importSource.replace(/^csv:/, 'CSV · ') : 'WhatsApp'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ImportWizard open={importing} onClose={() => setImporting(false)} onImported={load} />

      <Modal open={bulkOpen} onClose={() => setBulkOpen(false)} title="Bulk tools" subtitle={currentBotId ? `Applies to ${bots.find((b) => b.id === currentBotId)?.name}` : 'Applies to all numbers — pick one in the top bar to narrow it'} size="lg">
        <ContactsPanel
          botId={currentBotId || (bots.length === 1 ? bots[0].id : null)}
          onDone={load}
          onHint={(text) => setMessage({ tone: /fail|error|required|choose/i.test(text) ? 'error' : 'success', text })}
        />
      </Modal>
    </div>
  );
}
