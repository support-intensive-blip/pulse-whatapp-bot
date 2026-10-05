import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Copy, RefreshCw, Unplug, AlertTriangle } from 'lucide-react';
import { motion } from 'framer-motion';
import { botApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { SectionHeader, Button, Badge, Card } from '../components/ds';

const STEPS = [
  { n: 1, title: 'API key', desc: 'Gallabox → Settings → Developer → API Keys' },
  { n: 2, title: 'Server settings', desc: 'Set the GALLABOX_* values on the backend' },
  { n: 3, title: 'Webhook', desc: 'Gallabox → Settings → Webhooks → Message.Received' },
];

function formatTime(iso) {
  if (!iso) return 'No messages yet';
  return new Date(iso).toLocaleString();
}

export default function Connect() {
  const { refresh } = useAuth();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await botApi.status());
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [load]);

  async function handleRestart() {
    setLoading(true);
    setError('');
    try {
      setStatus(await botApi.start());
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Gallabox must call the backend (Render) directly, not this Netlify page.
  const webhookUrl =
    status?.gallabox?.webhookUrl ||
    `https://<your-render-service>.onrender.com${status?.gallabox?.webhookPath || '/webhooks/gallabox'}`;

  async function copyWebhook() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_err) {
      setCopied(false);
    }
  }

  const isReady = Boolean(status?.live?.ready);
  const configured = Boolean(status?.gallabox?.configured);
  const missing = status?.gallabox?.missing || [];
  const live = status?.live || {};

  return (
    <div className="mx-auto max-w-5xl">
      <SectionHeader
        title="WhatsApp connection"
        subtitle="Pulse is connected to WhatsApp Business through Gallabox."
        action={
          <Button variant="ghost" onClick={handleRestart} disabled={loading}>
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Reconnecting…' : 'Reconnect'}
          </Button>
        }
      />

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-3">
            {STEPS.map((step) => (
              <Card key={step.n} className="!p-4">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary-soft text-xs font-bold text-primary">
                  {step.n}
                </span>
                <p className="mt-3 text-sm font-semibold text-ink">{step.title}</p>
                <p className="mt-1 text-xs text-ink-muted">{step.desc}</p>
              </Card>
            ))}
          </div>

          <Card className="flex min-h-[300px] flex-col items-center justify-center text-center">
            {isReady ? (
              <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                <CheckCircle2 size={48} className="mx-auto text-success" />
                <h2 className="mt-4 text-lg font-semibold text-ink">Connected</h2>
                <p className="mt-1 text-sm text-ink-muted">+{live.phone || status?.whatsappPhone}</p>
                <Badge tone="live" dot className="mt-4">
                  Live
                </Badge>
              </motion.div>
            ) : !configured ? (
              <div className="flex max-w-md flex-col items-center px-4">
                <AlertTriangle size={40} className="text-warning" />
                <h2 className="mt-4 text-lg font-semibold text-ink">Gallabox is not configured</h2>
                <p className="mt-2 text-sm text-ink-muted">
                  Set these environment variables on the backend server, then press Reconnect:
                </p>
                <ul className="mt-3 space-y-1 font-mono text-xs text-ink">
                  {missing.map((key) => (
                    <li key={key}>{key}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex max-w-md flex-col items-center px-4">
                <Unplug size={40} className="text-ink-muted" />
                <h2 className="mt-4 text-lg font-semibold text-ink">Not connected to this account</h2>
                <p className="mt-2 text-sm text-ink-muted">
                  The Gallabox number is assigned to another dashboard account. Set GALLABOX_BOT_ACCOUNT_ID
                  on the server to move it here.
                </p>
              </div>
            )}
          </Card>

          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Webhook URL for Gallabox</p>
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink">{webhookUrl}</code>
              <Button variant="secondary" size="sm" onClick={copyWebhook}>
                <Copy size={16} />
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="mt-3 text-xs text-ink-muted">
              In Gallabox → Settings → Webhooks, add this URL with the <b>Message.Received</b> event and a secret
              matching GALLABOX_WEBHOOK_SECRET.
            </p>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Connection status</p>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-ink-muted">Provider</span>
                <span className="font-medium text-ink">Gallabox</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">State</span>
                <Badge tone={isReady ? 'live' : 'neutral'} dot>
                  {isReady ? 'ready' : 'disconnected'}
                </Badge>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-ink-muted">Last message</span>
                <span className="text-right font-medium text-ink">{formatTime(live.lastInboundAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Signature check</span>
                <span className="font-medium text-ink">{live.signatureCheck ? 'On' : 'Off'}</span>
              </div>
            </div>
            {live.lastError && (
              <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{live.lastError}</p>
            )}
          </Card>

          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Good to know</p>
            <ul className="mt-3 space-y-2 text-sm text-ink-muted">
              <li>Chats appear as soon as someone messages your number.</li>
              <li>Free-form replies only work within 24h of the contact's last message.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
