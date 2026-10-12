import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Columns3, List, Plus, Search, Zap } from 'lucide-react';
import { actionsApi, usersApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { fetchActionItemsFeed } from '../hooks/useActionItemsFeed';
import {
  Alert,
  Badge,
  Button,
  Drawer,
  EmptyState,
  Input,
  Modal,
  NumberBadge,
  SectionHeader,
  Select,
  Spinner,
  Textarea,
} from '../components/ds';
import { actionItemChatUrl, formatActionItemTime } from '../utils/actionLinks';
import { formatISTDate, formatISTTime, parseTimestamp } from '../utils/time';

export const STATUSES = [
  { id: 'open', label: 'Open', tone: 'warning' },
  { id: 'in_progress', label: 'In Progress', tone: 'primary' },
  { id: 'resolved', label: 'Resolved', tone: 'success' },
  { id: 'closed', label: 'Closed', tone: 'neutral' },
];
const PRIORITIES = [
  { id: 'urgent', label: 'Urgent', tone: 'danger' },
  { id: 'high', label: 'High', tone: 'warning' },
  { id: 'normal', label: 'Normal', tone: 'neutral' },
  { id: 'low', label: 'Low', tone: 'neutral' },
];
const VIEW_KEY = 'pulse_cta_view';

export function StatusBadge({ status }) {
  const meta = STATUSES.find((s) => s.id === status) || STATUSES[0];
  return <Badge tone={meta.tone} dot>{meta.label}</Badge>;
}

export function PriorityBadge({ priority }) {
  // 'l2' is what automatic escalations used before; it means "needs a human now".
  const meta = PRIORITIES.find((p) => p.id === (priority === 'l2' ? 'urgent' : priority)) || PRIORITIES[2];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

function isOverdue(item) {
  const due = parseTimestamp(item.due_date);
  return due && due < new Date() && (item.status === 'open' || item.status === 'in_progress');
}

function toDateInput(ts) {
  const d = parseTimestamp(ts);
  return d ? d.toISOString().slice(0, 10) : '';
}

function ActionDetailDrawer({ itemId, members, onClose, onSaved }) {
  const [item, setItem] = useState(null);
  const [conversation, setConversation] = useState([]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!itemId) return;
    setItem(null);
    setError('');
    actionsApi
      .get(itemId)
      .then((data) => {
        setItem(data.item);
        setConversation(data.conversation || []);
        setForm({
          status: data.item.status,
          priority: data.item.priority === 'l2' ? 'urgent' : data.item.priority || 'normal',
          assignedUserId: data.item.assigned_dashboard_user_id || '',
          dueDate: toDateInput(data.item.due_date),
          notes: data.item.notes || '',
          resolution: data.item.resolution || '',
        });
      })
      .catch((err) => setError(err.message));
  }, [itemId]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(extra = {}) {
    setBusy(true);
    setError('');
    try {
      const patch = { ...form, ...extra };
      const { item: updated } = await actionsApi.update(item.id, {
        status: patch.status,
        priority: patch.priority,
        assignedUserId: patch.assignedUserId ? Number(patch.assignedUserId) : null,
        dueDate: patch.dueDate || null,
        notes: patch.notes,
        resolution: patch.resolution,
      });
      onSaved(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={Boolean(itemId)}
      onClose={onClose}
      title={item?.title || 'Call to Action'}
      subtitle={item && (
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={item.status} />
          <NumberBadge name={item.bot_name} phone={item.bot_phone} />
          <span className="text-xs">{formatActionItemTime(item)}</span>
        </span>
      )}
      footer={
        form && (
          <>
            {form.status !== 'resolved' && (
              <Button variant="secondary" size="md" disabled={busy || !form.resolution.trim()} onClick={() => save({ status: 'resolved' })} title={form.resolution.trim() ? '' : 'Add resolution details first'}>
                Resolve
              </Button>
            )}
            <Button size="md" onClick={() => save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </>
        )
      }
    >
      {error && <Alert tone="error" className="mb-3">{error}</Alert>}
      {!item || !form ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <div className="space-y-5">
          <div className="space-y-1 text-sm">
            <p className="text-ink">
              <span className="text-ink-muted">Contact: </span>
              {item.contact_name || 'Unknown'} {item.contact_phone && <span className="text-ink-muted">· {item.contact_phone}</span>}
            </p>
            {item.description && <p className="whitespace-pre-wrap text-ink-muted">{item.description}</p>}
            <p className="text-xs text-ink-faint">
              Source: {item.source}{item.created_by_name ? ` · created by ${item.created_by_name}` : ''}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Status" value={form.status} onChange={set('status')}>
              {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
            <Select label="Priority" value={form.priority} onChange={set('priority')}>
              {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
            <Select label="Assigned to" value={form.assignedUserId} onChange={set('assignedUserId')}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
            <Input label="Due date" type="date" value={form.dueDate} onChange={set('dueDate')} />
          </div>
          <Textarea label="Notes" value={form.notes} onChange={set('notes')} rows={3} />
          <Textarea label="Resolution details" hint="What was done — required to resolve" value={form.resolution} onChange={set('resolution')} rows={3} />

          {item.chat_profile_id && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-ink">Conversation</p>
                <Link to={actionItemChatUrl(item)} className="text-xs font-medium text-primary hover:underline">Open in Inbox</Link>
              </div>
              <div className="max-h-80 space-y-2 overflow-y-auto rounded-xl bg-[#efeae2] p-3">
                {conversation.length ? (
                  conversation.map((m) => (
                    <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}`}>
                      <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs shadow-sm ${m.role === 'user' ? 'bg-white' : m.role === 'assistant' ? 'bg-ai-soft' : 'bg-[#d9fdd3]'} ${m.id === item.trigger_message_id ? 'ring-2 ring-warning' : ''}`}>
                        <span className="whitespace-pre-wrap text-ink">{m.content}</span>
                        <span className="mt-0.5 block text-right text-[10px] text-ink-faint">
                          {m.role === 'assistant' ? 'AI · ' : m.role === 'owner' ? 'Team · ' : ''}{formatISTTime(m.timestamp)}
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-center text-xs text-ink-muted">No messages.</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

function CreateActionModal({ open, onClose, members, onCreated }) {
  const { bots, currentBotId } = useAuth();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setForm({ title: '', description: '', botId: currentBotId || bots[0]?.id || '', priority: 'normal', assignedUserId: '', dueDate: '' });
      setError('');
    }
  }, [open, currentBotId, bots]);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save() {
    setBusy(true);
    setError('');
    try {
      const { item } = await actionsApi.create({
        ...form,
        botId: Number(form.botId),
        assignedUserId: form.assignedUserId ? Number(form.assignedUserId) : null,
        dueDate: form.dueDate || null,
      });
      onCreated(item);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Call to Action"
      subtitle="For follow-ups tied to a specific chat, use “Create action” in the Inbox."
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>Cancel</Button>
          <Button size="md" onClick={save} disabled={busy || !form.title?.trim() || !form.botId}>{busy ? 'Creating…' : 'Create'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Input label="Title" value={form.title || ''} onChange={set('title')} autoFocus />
        <Textarea label="Description" value={form.description || ''} onChange={set('description')} rows={3} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="WhatsApp number" value={form.botId || ''} onChange={set('botId')}>
            {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Select label="Priority" value={form.priority || 'normal'} onChange={set('priority')}>
            {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
          <Select label="Assign to" value={form.assignedUserId || ''} onChange={set('assignedUserId')}>
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          <Input label="Due date" type="date" value={form.dueDate || ''} onChange={set('dueDate')} />
        </div>
      </div>
    </Modal>
  );
}

function KanbanCard({ item, onOpen, onMove }) {
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', String(item.id))}
      className="cursor-grab rounded-xl border border-border bg-white p-3 shadow-card active:cursor-grabbing"
    >
      <button type="button" onClick={() => onOpen(item.id)} className="block w-full text-left">
        <span className="line-clamp-2 text-sm font-medium text-ink">{item.title}</span>
        <span className="mt-1 block truncate text-xs text-ink-muted">{item.contact_name || 'No contact'}</span>
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <PriorityBadge priority={item.priority} />
        <NumberBadge name={item.bot_name} phone={item.bot_phone} />
        {item.due_date && (
          <span className={`text-[11px] ${isOverdue(item) ? 'font-semibold text-red-700' : 'text-ink-muted'}`}>Due {formatISTDate(item.due_date)}</span>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-ink-muted">{item.assigned_user_name || 'Unassigned'}</span>
        <select
          aria-label={`Move “${item.title}”`}
          value={item.status}
          onChange={(e) => onMove(item, e.target.value)}
          className="h-7 rounded-md border border-border bg-white px-1 text-[11px]"
        >
          {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>
    </div>
  );
}

export default function ActionItems() {
  const { scopeVersion } = useAuth();
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem(VIEW_KEY) || 'table';
    } catch {
      return 'table';
    }
  });
  const [filters, setFilters] = useState({ status: 'active', assigned: '', priority: '', due: '', search: '' });
  const [items, setItems] = useState(null);
  const [members, setMembers] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  // Kanban shows every column, so it ignores the status filter.
  const load = useCallback(async () => {
    try {
      const data = await actionsApi.list({
        status: view === 'kanban' ? '' : filters.status,
        assigned: filters.assigned,
        priority: filters.priority,
        dueBefore: filters.due === 'overdue' ? new Date().toISOString() : '',
        search: filters.search,
      });
      setItems(data.items);
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    }
  }, [filters, view]);

  useEffect(() => {
    const t = setTimeout(load, filters.search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, scopeVersion]);

  useEffect(() => {
    usersApi.members().then((d) => setMembers(d.members)).catch(() => {});
  }, [scopeVersion]);

  function changeView(next) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // not remembered
    }
  }

  async function move(item, status) {
    if (item.status === status) return;
    if (status === 'resolved' && !item.resolution) {
      setOpenId(item.id);
      setMessage({ tone: 'info', text: 'Add resolution details, then resolve.' });
      return;
    }
    setItems((list) => list.map((i) => (i.id === item.id ? { ...i, status } : i)));
    try {
      await actionsApi.update(item.id, { status });
      fetchActionItemsFeed(undefined, { silent: true });
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
      load();
    }
  }

  const grouped = useMemo(() => {
    const map = Object.fromEntries(STATUSES.map((s) => [s.id, []]));
    for (const item of items || []) (map[item.status] || map.open).push(item);
    return map;
  }, [items]);

  const setFilter = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const filterSelect = 'h-10 rounded-xl border border-border bg-white px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

  return (
    <div className="mx-auto max-w-7xl">
      <SectionHeader
        title="Call to Actions"
        subtitle="Follow-ups raised by AI escalation, media the bot can't handle, or your team."
        action={<Button onClick={() => setCreating(true)}><Plus size={16} /> New action</Button>}
      />
      {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)} className="mb-4">{message.text}</Alert>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input type="search" value={filters.search} onChange={setFilter('search')} placeholder="Search title or contact…" aria-label="Search actions" className={`${filterSelect} w-full pl-9`} />
        </div>
        {view === 'table' && (
          <select aria-label="Status" value={filters.status} onChange={setFilter('status')} className={filterSelect}>
            <option value="active">Open + In progress</option>
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            <option value="">All statuses</option>
          </select>
        )}
        <select aria-label="Assignee" value={filters.assigned} onChange={setFilter('assigned')} className={filterSelect}>
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select aria-label="Priority" value={filters.priority} onChange={setFilter('priority')} className={filterSelect}>
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="l2">Escalation (auto)</option>
        </select>
        <select aria-label="Due date" value={filters.due} onChange={setFilter('due')} className={filterSelect}>
          <option value="">Any due date</option>
          <option value="overdue">Overdue</option>
        </select>
        <div className="ml-auto inline-flex rounded-xl border border-border bg-slate-50 p-1" role="group" aria-label="View">
          <button type="button" onClick={() => changeView('table')} aria-pressed={view === 'table'} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${view === 'table' ? 'bg-white text-ink shadow-sm' : 'text-ink-muted'}`}>
            <List size={14} /> Table
          </button>
          <button type="button" onClick={() => changeView('kanban')} aria-pressed={view === 'kanban'} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${view === 'kanban' ? 'bg-white text-ink shadow-sm' : 'text-ink-muted'}`}>
            <Columns3 size={14} /> Kanban
          </button>
        </div>
      </div>

      {!items ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : view === 'kanban' ? (
        <div className="grid gap-4 overflow-x-auto pb-2 md:grid-cols-2 xl:grid-cols-4">
          {STATUSES.map((s) => (
            <section
              key={s.id}
              aria-label={s.label}
              onDragOver={(e) => {
                e.preventDefault();
                setDropTarget(s.id);
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget(null);
                const item = items.find((i) => String(i.id) === e.dataTransfer.getData('text/plain'));
                if (item) move(item, s.id);
              }}
              className={`min-h-[12rem] rounded-xl border p-3 transition-colors ${dropTarget === s.id ? 'border-primary bg-primary-soft' : 'border-border bg-slate-50'}`}
            >
              <header className="mb-3 flex items-center justify-between">
                <StatusBadge status={s.id} />
                <span className="text-xs tabular-nums text-ink-muted">{grouped[s.id].length}</span>
              </header>
              <div className="space-y-2">
                {grouped[s.id].map((item) => (
                  <KanbanCard key={item.id} item={item} onOpen={setOpenId} onMove={move} />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : !items.length ? (
        <EmptyState icon={Zap} title="Nothing to follow up" description="Action items appear when the AI escalates a chat, a student sends media, or someone creates one." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-white shadow-card">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-border bg-slate-50/80 text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Action</th>
                <th className="px-4 py-3 font-semibold">Contact</th>
                <th className="px-4 py-3 font-semibold">Number</th>
                <th className="px-4 py-3 font-semibold">Priority</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Assigned</th>
                <th className="px-4 py-3 font-semibold">Due</th>
                <th className="px-4 py-3 font-semibold">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((item) => (
                <tr key={item.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenId(item.id)}>
                  <td className="max-w-xs px-4 py-3">
                    <button type="button" className="block max-w-full truncate text-left font-medium text-ink hover:underline" onClick={(e) => { e.stopPropagation(); setOpenId(item.id); }}>
                      {item.title}
                    </button>
                    {item.description && <p className="truncate text-xs text-ink-muted">{item.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-ink">{item.contact_name || <span className="text-ink-faint">—</span>}</td>
                  <td className="px-4 py-3"><NumberBadge name={item.bot_name} phone={item.bot_phone} /></td>
                  <td className="px-4 py-3"><PriorityBadge priority={item.priority} /></td>
                  <td className="px-4 py-3"><StatusBadge status={item.status} /></td>
                  <td className="px-4 py-3 text-ink">{item.assigned_user_name || <span className="text-ink-faint">Unassigned</span>}</td>
                  <td className={`px-4 py-3 ${isOverdue(item) ? 'font-semibold text-red-700' : 'text-ink-muted'}`}>{item.due_date ? formatISTDate(item.due_date) : '—'}</td>
                  <td className="px-4 py-3 text-ink-muted">{formatISTDate(item.triggered_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ActionDetailDrawer
        itemId={openId}
        members={members}
        onClose={() => setOpenId(null)}
        onSaved={() => {
          setOpenId(null);
          setMessage({ tone: 'success', text: 'Action updated.' });
          load();
          fetchActionItemsFeed(undefined, { silent: true });
        }}
      />
      <CreateActionModal
        open={creating}
        onClose={() => setCreating(false)}
        members={members}
        onCreated={() => {
          setCreating(false);
          setMessage({ tone: 'success', text: 'Action created.' });
          load();
          fetchActionItemsFeed(undefined, { silent: true });
        }}
      />
    </div>
  );
}
