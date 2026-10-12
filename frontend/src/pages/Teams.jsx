import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Check, Plus, Search } from 'lucide-react';
import { teamsApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Input, Modal, SectionHeader, Spinner, Textarea } from '../components/ds';
import { formatISTDate } from '../utils/time';

const STEPS = ['Team', 'Admin', 'Review'];

const PERMISSIONS = [
  ['Team Admin', 'Connect WhatsApp numbers, configure AI prompts and knowledge, manage users, plus everything a user can do.'],
  ['Team User', 'Inbox, AI on/off per chat, manual replies, contacts and CSV import, Call-to-Actions.'],
  ['Never shared', 'API secrets are write-only; users never see prompts, secrets or other teams.'],
];

function CreateTeamModal({ open, onClose, onCreated }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ name: '', description: '', adminName: '', adminEmail: '', adminPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setStep(0);
      setError('');
      setForm({ name: '', description: '', adminName: '', adminEmail: '', adminPassword: '' });
    }
  }, [open]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const canNext =
    (step === 0 && form.name.trim()) ||
    (step === 1 && form.adminName.trim() && form.adminEmail.trim() && form.adminPassword.length >= 8) ||
    step === 2;

  async function create() {
    setBusy(true);
    setError('');
    try {
      const data = await teamsApi.create({
        name: form.name,
        description: form.description,
        admin: { name: form.adminName, email: form.adminEmail, password: form.adminPassword },
      });
      onCreated(data);
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
      title="Create team"
      subtitle={`Step ${step + 1} of ${STEPS.length} · ${STEPS[step]}`}
      footer={
        <>
          {step > 0 && (
            <Button variant="secondary" size="md" onClick={() => setStep((s) => s - 1)} disabled={busy}>
              Back
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button size="md" onClick={() => setStep((s) => s + 1)} disabled={!canNext}>
              Continue
            </Button>
          ) : (
            <Button size="md" onClick={create} disabled={busy}>
              {busy ? 'Creating…' : 'Create team'}
            </Button>
          )}
        </>
      }
    >
      <ol className="mb-5 flex gap-2" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li key={label} className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-slate-200'}`} aria-current={i === step ? 'step' : undefined}>
            <span className="sr-only">{label}</span>
          </li>
        ))}
      </ol>
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}

      {step === 0 && (
        <div className="space-y-4">
          <Input label="Team name" value={form.name} onChange={set('name')} placeholder="e.g. Student Support" autoFocus />
          <Textarea label="Description" value={form.description} onChange={set('description')} rows={3} placeholder="What this team handles (optional)" />
        </div>
      )}
      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">The Team Admin connects WhatsApp numbers and invites the rest of the team.</p>
          <Input label="Admin name" value={form.adminName} onChange={set('adminName')} autoFocus />
          <Input label="Admin email (login)" type="email" value={form.adminEmail} onChange={set('adminEmail')} />
          <Input
            label="Temporary password"
            hint="At least 8 characters. Share it privately; they can change it under Settings."
            type="text"
            value={form.adminPassword}
            onChange={set('adminPassword')}
            autoComplete="off"
          />
        </div>
      )}
      {step === 2 && (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 rounded-xl bg-slate-50 p-4">
            <dt className="text-ink-muted">Team</dt>
            <dd className="font-medium text-ink">{form.name}</dd>
            <dt className="text-ink-muted">Team Admin</dt>
            <dd className="text-ink">{form.adminName} · {form.adminEmail}</dd>
          </dl>
          <ul className="space-y-2.5">
            {PERMISSIONS.map(([role, text]) => (
              <li key={role} className="flex gap-2.5">
                <Check size={16} className="mt-0.5 shrink-0 text-success" />
                <span>
                  <span className="font-medium text-ink">{role}: </span>
                  <span className="text-ink-muted">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

export default function Teams() {
  const { refresh, switchTeam } = useAuth();
  const navigate = useNavigate();
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [toggle, setToggle] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  async function load() {
    try {
      setTeams((await teamsApi.list()).teams);
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? teams.filter((t) => `${t.name} ${t.adminNames || ''}`.toLowerCase().includes(q)) : teams;
  }, [teams, search]);

  async function confirmToggle() {
    setBusy(true);
    try {
      await teamsApi.update(toggle.id, { isActive: !toggle.isActive });
      setMessage({ tone: 'success', text: `${toggle.name} ${toggle.isActive ? 'deactivated — its numbers stopped replying' : 'activated'}.` });
      setToggle(null);
      await Promise.all([load(), refresh()]);
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleCreated({ team, admin }) {
    setCreateOpen(false);
    setMessage({ tone: 'success', text: `${team.name} created. ${admin?.email} can now sign in as Team Admin.` });
    await load();
    await switchTeam(team.id);
    navigate('/bots');
  }

  return (
    <div className="mx-auto max-w-6xl">
      <SectionHeader
        eyebrow="Platform"
        title="Teams"
        subtitle="Each team runs its own WhatsApp numbers, AI bots, users and data."
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Create team
          </Button>
        }
      />
      {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)} className="mb-4">{message.text}</Alert>}

      <div className="relative mb-4 max-w-sm">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search teams or admins…"
          aria-label="Search teams"
          className="h-10 w-full rounded-xl border border-border bg-white pl-9 pr-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !teams.length ? (
        <EmptyState icon={Building2} title="No teams yet" description="Create the first team and assign its admin." action={<Button onClick={() => setCreateOpen(true)}>Create team</Button>} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-white shadow-card">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-border bg-slate-50/80 text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Team</th>
                <th className="px-4 py-3 font-semibold">Team Admin</th>
                <th className="px-4 py-3 text-right font-semibold">Numbers</th>
                <th className="px-4 py-3 text-right font-semibold">Users</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-ink">{t.name}</p>
                    {t.description && <p className="max-w-xs truncate text-xs text-ink-muted">{t.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-ink">{t.adminNames || <span className="text-ink-faint">Not assigned</span>}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.botCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.userCount}</td>
                  <td className="px-4 py-3">
                    <Badge tone={t.isActive ? 'success' : 'neutral'} dot>{t.isActive ? 'Active' : 'Inactive'}</Badge>
                  </td>
                  <td className="px-4 py-3 text-ink-muted">{formatISTDate(t.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          await switchTeam(t.id);
                          navigate('/');
                        }}
                      >
                        Open
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setToggle(t)}>
                        {t.isActive ? 'Deactivate' : 'Activate'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateTeamModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={handleCreated} />
      <ConfirmDialog
        open={Boolean(toggle)}
        title={toggle?.isActive ? `Deactivate ${toggle?.name}?` : `Activate ${toggle?.name}?`}
        message={
          toggle?.isActive
            ? 'Its users are signed out, and its WhatsApp numbers stop replying until the team is activated again. Data is kept.'
            : 'Its users can sign in again and its configured numbers resume.'
        }
        confirmLabel={toggle?.isActive ? 'Deactivate' : 'Activate'}
        tone={toggle?.isActive ? 'danger' : 'primary'}
        busy={busy}
        onConfirm={confirmToggle}
        onCancel={() => setToggle(null)}
      />
    </div>
  );
}
