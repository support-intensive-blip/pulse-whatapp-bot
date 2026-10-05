import React, { useEffect, useState } from 'react';
import { FlaskConical, Plus, X } from 'lucide-react';
import { botApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { SectionHeader, Input, Button, Card, Badge, Toggle } from '../components/ds';

function canonicalPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function formatPhone(phone) {
  const p = String(phone || '');
  if (p.length === 12 && p.startsWith('91')) return `+91 ${p.slice(2, 7)} ${p.slice(7)}`;
  return `+${p}`;
}

function formFromBot(bot) {
  return {
    name: bot.name || '',
    assistantName: bot.assistantName || '',
    assistantContactsEnabled: bot.assistantContactsEnabled ?? true,
    testModeEnabled: bot.testModeEnabled ?? false,
    testNumbers: bot.testNumbers || [],
  };
}

export default function BotSettings() {
  const { bot, refresh } = useAuth();
  const [form, setForm] = useState({
    name: '',
    assistantName: '',
    assistantContactsEnabled: true,
    testModeEnabled: false,
    testNumbers: [],
  });
  const [dirty, setDirty] = useState(false);
  const [newNumber, setNewNumber] = useState('');
  const [numberError, setNumberError] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Background refreshes must not wipe edits the user hasn't saved yet.
  useEffect(() => {
    if (bot && !dirty) setForm(formFromBot(bot));
  }, [bot, dirty]);

  useEffect(() => {
    const timer = setInterval(() => refresh({ logoutOnUnauthorized: false }), 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  function update(patch) {
    setForm((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }

  function handleAddNumber() {
    const phone = canonicalPhone(newNumber);
    if (phone.length < 11 || phone.length > 13) {
      setNumberError('Enter a 10-digit mobile number, or the full number with country code.');
      return;
    }
    if (form.testNumbers.includes(phone)) {
      setNumberError('That number is already in the list.');
      return;
    }
    update({ testNumbers: [...form.testNumbers, phone] });
    setNewNumber('');
    setNumberError('');
  }

  function handleRemoveNumber(phone) {
    update({ testNumbers: form.testNumbers.filter((p) => p !== phone) });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSaved(false);
    setSaving(true);
    try {
      await botApi.updateSettings(form);
      setDirty(false);
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const testModeLive = Boolean(bot?.testModeEnabled);

  return (
    <div className="mx-auto max-w-3xl">
      <SectionHeader
        title="Settings"
        subtitle="General bot preferences synced with your WhatsApp assistant."
        action={
          bot && (
            <div className="flex items-center gap-2">
              {testModeLive && (
                <Badge tone="warning" dot>
                  Testing mode
                </Badge>
              )}
              <Badge tone={bot.status === 'ready' ? 'live' : 'neutral'} dot>
                {bot.status === 'ready' ? 'Connected' : 'Offline'}
              </Badge>
            </div>
          )
        }
      />

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}
        {saved && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            Settings saved
          </div>
        )}

        <Card>
          <h2 className="text-sm font-semibold text-ink">General</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Input label="Bot name" value={form.name} onChange={(e) => update({ name: e.target.value })} />
            <Input
              label="Assistant name"
              value={form.assistantName}
              onChange={(e) => update({ assistantName: e.target.value })}
            />
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-ink">Controls</h2>
          <div className="mt-4 space-y-3">
            <Toggle
              label="Contact chats AI"
              description="Enable AI for all contact conversations globally"
              checked={form.assistantContactsEnabled}
              onChange={(v) => update({ assistantContactsEnabled: v })}
            />
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-2">
            <FlaskConical size={16} className="text-ink-muted" />
            <h2 className="text-sm font-semibold text-ink">Testing mode</h2>
          </div>
          <div className="mt-4 space-y-4">
            <Toggle
              label="Only reply to test numbers"
              description="While on, the bot answers only the numbers below. Messages from everyone else are still saved, but get no reply."
              checked={form.testModeEnabled}
              onChange={(v) => update({ testModeEnabled: v })}
            />

            <div>
              <p className="text-sm font-medium text-ink">Test numbers</p>
              <div className="mt-2 flex gap-2">
                <div className="flex-1">
                  <Input
                    placeholder="98765 43210 or +91 98765 43210"
                    inputMode="tel"
                    value={newNumber}
                    onChange={(e) => {
                      setNewNumber(e.target.value);
                      setNumberError('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddNumber();
                      }
                    }}
                  />
                </div>
                <Button type="button" variant="secondary" onClick={handleAddNumber} disabled={!newNumber.trim()}>
                  <Plus size={16} />
                  Add
                </Button>
              </div>
              {numberError && <p className="mt-1.5 text-xs text-red-600">{numberError}</p>}

              {form.testNumbers.length === 0 ? (
                <p className="mt-3 text-xs text-ink-muted">
                  No test numbers yet.
                  {form.testModeEnabled && ' With testing mode on and an empty list, the bot replies to no one.'}
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
                  {form.testNumbers.map((phone) => (
                    <li key={phone} className="flex items-center justify-between px-4 py-2.5 text-sm">
                      <span className="font-medium tabular-nums text-ink">{formatPhone(phone)}</span>
                      <button
                        type="button"
                        className="rounded-lg p-1 text-ink-muted hover:bg-slate-100 hover:text-ink"
                        onClick={() => handleRemoveNumber(phone)}
                        aria-label={`Remove ${formatPhone(phone)}`}
                      >
                        <X size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
          {dirty && !saving && <span className="text-xs text-ink-muted">Unsaved changes</span>}
        </div>
      </form>
    </div>
  );
}
