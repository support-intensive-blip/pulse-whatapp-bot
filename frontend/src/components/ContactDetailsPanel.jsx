import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import { actionsApi, dataApi, usersApi } from '../api/client';
import { fetchActionItemsFeed } from '../hooks/useActionItemsFeed';
import { Alert, Badge, Button, Input, Modal, NumberBadge, Select, Textarea, formatPhone } from './ds';
import { StatusBadge } from '../pages/ActionItems';
import { formatISTDate } from '../utils/time';

let membersCache = null;

function useMembers() {
  const [members, setMembers] = useState(membersCache || []);
  useEffect(() => {
    usersApi
      .members()
      .then((d) => {
        membersCache = d.members;
        setMembers(d.members);
      })
      .catch(() => {});
  }, []);
  return members;
}

function CreateActionForChat({ chat, members, open, onClose, onCreated }) {
  const [form, setForm] = useState({ title: '', description: '', priority: 'high', assignedUserId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setForm({ title: `Follow up: ${chat?.contactName || 'contact'}`, description: '', priority: 'high', assignedUserId: '' });
      setError('');
    }
  }, [open, chat]);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save() {
    setBusy(true);
    setError('');
    try {
      const data = await dataApi.escalateChat(chat.id, {
        title: form.title,
        description: form.description || undefined,
        priority: form.priority,
        assignedUserId: form.assignedUserId ? Number(form.assignedUserId) : undefined,
      });
      onCreated(data.message);
      fetchActionItemsFeed(undefined, { silent: true });
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
      title="Create action"
      subtitle={`Linked to this chat on ${chat?.botName || 'this number'}`}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>Cancel</Button>
          <Button size="md" onClick={save} disabled={busy || !form.title.trim()}>{busy ? 'Creating…' : 'Create'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Input label="Title" value={form.title} onChange={set('title')} />
        <Textarea label="Details" hint="Defaults to the contact's last message" value={form.description} onChange={set('description')} rows={3} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Priority" value={form.priority} onChange={set('priority')}>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </Select>
          <Select label="Assign to" value={form.assignedUserId} onChange={set('assignedUserId')}>
            <option value="">Me</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </div>
      </div>
    </Modal>
  );
}

/** Right-hand contact card: who this is, which number, assignee, tags, notes, follow-ups. */
export default function ContactDetailsPanel({ chat, onChatUpdate }) {
  const members = useMembers();
  const [actions, setActions] = useState([]);
  const [notes, setNotes] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState(null);

  const loadActions = () =>
    actionsApi
      .list({ chatProfileId: chat.id, status: '' })
      .then((d) => setActions(d.items))
      .catch(() => {});

  useEffect(() => {
    if (!chat?.id) return;
    setNotes(chat.contactNotes || '');
    setMessage(null);
    loadActions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id]);

  if (!chat) return null;

  async function patch(body, okText) {
    setSaving(true);
    try {
      const data = await dataApi.updateContact(chat.id, body);
      onChatUpdate?.(data.chat);
      if (okText) setMessage({ tone: 'success', text: okText });
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  function addTag(e) {
    e.preventDefault();
    const tag = tagInput.trim();
    if (!tag || chat.tags?.includes(tag)) return;
    setTagInput('');
    patch({ tags: [...(chat.tags || []), tag] });
  }

  return (
    <div className="space-y-5 p-4">
      {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)}>{message.text}</Alert>}

      <div>
        <p className="text-base font-semibold text-ink">{chat.contactName}</p>
        <p className="text-sm text-ink-muted">{chat.contactPhone ? formatPhone(chat.contactPhone) : 'No phone'}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-muted">Writing to</span>
          <NumberBadge name={chat.botName} phone={chat.botPhone} />
        </div>
      </div>

      <Select
        label="Assigned to"
        value={chat.assignedUserId || ''}
        disabled={saving}
        onChange={(e) => patch({ assignedUserId: e.target.value ? Number(e.target.value) : null }, 'Assignee updated.')}
      >
        <option value="">Unassigned</option>
        {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </Select>

      <div>
        <p className="mb-1.5 text-sm font-medium text-ink">Tags</p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {(chat.tags || []).map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-ink">
              {tag}
              <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => patch({ tags: chat.tags.filter((t) => t !== tag) })} className="text-ink-muted hover:text-ink">
                <X size={12} />
              </button>
            </span>
          ))}
          {!chat.tags?.length && <span className="text-xs text-ink-faint">No tags</span>}
        </div>
        <form onSubmit={addTag} className="flex gap-2">
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            placeholder="Add tag"
            aria-label="Add tag"
            maxLength={40}
            className="h-9 min-w-0 flex-1 rounded-lg border border-border px-2.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!tagInput.trim() || saving}>Add</Button>
        </form>
      </div>

      <div>
        <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Visible to your team only" />
        {notes !== (chat.contactNotes || '') && (
          <div className="mt-2 flex justify-end">
            <Button size="sm" onClick={() => patch({ contactNotes: notes }, 'Notes saved.')} disabled={saving}>Save notes</Button>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium text-ink">Call-to-Actions</p>
          <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} /> Create action
          </Button>
        </div>
        {actions.length ? (
          <ul className="space-y-2">
            {actions.slice(0, 6).map((a) => (
              <li key={a.id} className="rounded-lg border border-border p-2.5">
                <p className="truncate text-sm text-ink">{a.title}</p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <StatusBadge status={a.status} />
                  <span className="text-[11px] text-ink-muted">{a.assigned_user_name || 'Unassigned'} · {formatISTDate(a.triggered_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-faint">No follow-ups for this chat.</p>
        )}
        {actions.length > 0 && (
          <Link to="/actions" className="mt-2 inline-block text-xs font-medium text-primary hover:underline">All Call-to-Actions</Link>
        )}
      </div>

      {chat.importSource && <Badge tone="neutral">Imported · {chat.importSource.replace(/^csv:/, '')}</Badge>}

      <CreateActionForChat
        chat={chat}
        members={members}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(text) => {
          setCreating(false);
          setMessage({ tone: 'success', text });
          loadActions();
        }}
      />
    </div>
  );
}
