import React, { useEffect, useState } from 'react';
import { botApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { SectionHeader, Input, Button, Card, Badge, Toggle } from '../components/ds';

export default function BotSettings() {
  const { bot, refresh } = useAuth();
  const [form, setForm] = useState({
    name: '',
    assistantName: '',
    assistantSelfEnabled: true,
    assistantContactsEnabled: true,
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (bot) {
      setForm({
        name: bot.name || '',
        assistantName: bot.assistantName || '',
        assistantSelfEnabled: bot.assistantSelfEnabled ?? true,
        assistantContactsEnabled: bot.assistantContactsEnabled ?? true,
      });
    }
  }, [bot]);

  useEffect(() => {
    const timer = setInterval(() => refresh({ logoutOnUnauthorized: false }), 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSaved(false);
    setSaving(true);
    try {
      await botApi.updateSettings(form);
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <SectionHeader
        title="Settings"
        subtitle="General bot preferences synced with your WhatsApp assistant."
        action={
          bot && (
            <Badge tone={bot.status === 'ready' ? 'live' : 'neutral'} dot>
              {bot.status === 'ready' ? 'Connected' : 'Offline'}
            </Badge>
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
            <Input
              label="Bot name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              label="Assistant name"
              value={form.assistantName}
              onChange={(e) => setForm({ ...form, assistantName: e.target.value })}
            />
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-ink">Controls</h2>
          <div className="mt-4 space-y-3">
            <Toggle
              label="Self chat AI"
              description="Assistant replies in your Message Yourself chat"
              checked={form.assistantSelfEnabled}
              onChange={(v) => setForm({ ...form, assistantSelfEnabled: v })}
            />
            <Toggle
              label="Contact chats AI"
              description="Enable AI for all contact conversations globally"
              checked={form.assistantContactsEnabled}
              onChange={(v) => setForm({ ...form, assistantContactsEnabled: v })}
            />
          </div>
        </Card>

        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </form>
    </div>
  );
}
