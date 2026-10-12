import React, { useEffect, useState } from 'react';
import { Plus, Users } from 'lucide-react';
import { usersApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Input, Modal, SectionHeader, Select, Spinner, UserAvatar } from '../components/ds';
import { formatISTDate } from '../utils/time';

const ROLE_OPTIONS = [
  { value: 'team_user', label: 'Team User', hint: 'Inbox, contacts, AI on/off per chat, Call-to-Actions' },
  { value: 'team_admin', label: 'Team Admin', hint: 'Everything a user can do, plus numbers, prompts, knowledge and users' },
];

function UserModal({ open, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'team_user' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setForm({ name: '', email: '', password: '', role: 'team_user' });
      setError('');
    }
  }, [open]);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save() {
    setBusy(true);
    setError('');
    try {
      const { user } = await usersApi.create(form);
      onSaved(user);
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
      title="Add team member"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>Cancel</Button>
          <Button size="md" onClick={save} disabled={busy || !form.name.trim() || !form.email.trim() || form.password.length < 8}>
            {busy ? 'Adding…' : 'Add member'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Input label="Name" value={form.name} onChange={set('name')} autoFocus />
        <Input label="Email (login)" type="email" value={form.email} onChange={set('email')} />
        <Input label="Temporary password" hint="At least 8 characters — share it privately" value={form.password} onChange={set('password')} autoComplete="off" />
        <Select label="Role" value={form.role} onChange={set('role')}>
          {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </Select>
        <p className="text-xs text-ink-muted">{ROLE_OPTIONS.find((r) => r.value === form.role)?.hint}</p>
      </div>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose, onDone }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setPassword('');
    setError('');
  }, [user]);

  async function save() {
    setBusy(true);
    try {
      await usersApi.resetPassword(user.id, password);
      onDone(`Password reset for ${user.name}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={Boolean(user)}
      onClose={onClose}
      title={`Reset password · ${user?.name}`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>Cancel</Button>
          <Button size="md" onClick={save} disabled={busy || password.length < 8}>{busy ? 'Saving…' : 'Set password'}</Button>
        </>
      }
    >
      {error && <Alert tone="error" className="mb-3">{error}</Alert>}
      <Input label="New temporary password" hint="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
    </Modal>
  );
}

export default function TeamUsers() {
  const { team, user: me, scopeVersion } = useAuth();
  const [users, setUsers] = useState(null);
  const [adding, setAdding] = useState(false);
  const [resetFor, setResetFor] = useState(null);
  const [toggle, setToggle] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  async function load() {
    try {
      setUsers((await usersApi.list()).users);
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    }
  }

  useEffect(() => {
    load();
  }, [scopeVersion, team?.id]);

  async function changeRole(u, role) {
    try {
      await usersApi.update(u.id, { role });
      setMessage({ tone: 'success', text: `${u.name} is now ${role === 'team_admin' ? 'a Team Admin' : 'a Team User'}.` });
      load();
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    }
  }

  async function confirmToggle() {
    setBusy(true);
    try {
      await usersApi.update(toggle.id, { isActive: !toggle.isActive });
      setMessage({ tone: 'success', text: `${toggle.name} ${toggle.isActive ? 'deactivated' : 'reactivated'}.` });
      setToggle(null);
      load();
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <SectionHeader
        eyebrow={team?.name}
        title="Team & Users"
        subtitle="Who can sign in to this team's workspace."
        action={<Button onClick={() => setAdding(true)}><Plus size={16} /> Add member</Button>}
      />
      {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)} className="mb-4">{message.text}</Alert>}

      {!users ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !users.length ? (
        <EmptyState icon={Users} title="No members yet" action={<Button onClick={() => setAdding(true)}>Add member</Button>} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-white shadow-card">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b border-border bg-slate-50/80 text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Member</th>
                <th className="px-4 py-3 font-semibold">Role</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Added</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((u) => {
                const isMe = u.id === me?.id;
                return (
                  <tr key={u.id} className={u.isActive ? '' : 'opacity-60'}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <UserAvatar name={u.name} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink">{u.name}{isMe ? ' (you)' : ''}</p>
                          <p className="truncate text-xs text-ink-muted">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        aria-label={`Role of ${u.name}`}
                        value={u.role}
                        disabled={isMe || !u.isActive}
                        onChange={(e) => changeRole(u, e.target.value)}
                        className="h-9 rounded-lg border border-border bg-white px-2 text-sm disabled:bg-slate-50"
                      >
                        {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={u.isActive ? 'success' : 'neutral'} dot>{u.isActive ? 'Active' : 'Deactivated'}</Badge>
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{formatISTDate(u.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setResetFor(u)} disabled={!u.isActive}>Reset password</Button>
                        {!isMe && (
                          <Button variant="ghost" size="sm" onClick={() => setToggle(u)}>{u.isActive ? 'Deactivate' : 'Reactivate'}</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <UserModal
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={(u) => {
          setAdding(false);
          setMessage({ tone: 'success', text: `${u.name} added. They sign in with ${u.email} and the temporary password.` });
          load();
        }}
      />
      <ResetPasswordModal
        user={resetFor}
        onClose={() => setResetFor(null)}
        onDone={(text) => {
          setResetFor(null);
          setMessage({ tone: 'success', text });
        }}
      />
      <ConfirmDialog
        open={Boolean(toggle)}
        title={toggle?.isActive ? `Deactivate ${toggle?.name}?` : `Reactivate ${toggle?.name}?`}
        message={toggle?.isActive ? 'They are signed out and can no longer sign in. Their history and assignments are kept.' : 'They can sign in again.'}
        confirmLabel={toggle?.isActive ? 'Deactivate' : 'Reactivate'}
        tone={toggle?.isActive ? 'danger' : 'primary'}
        busy={busy}
        onConfirm={confirmToggle}
        onCancel={() => setToggle(null)}
      />
    </div>
  );
}
