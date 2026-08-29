import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Smartphone, QrCode, CheckCircle2, Loader2, Unplug } from 'lucide-react';
import { motion } from 'framer-motion';
import { botApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { SectionHeader, Button, Badge, Card } from '../components/ds';

function formatPairingCode(code) {
  if (!code) return '';
  const clean = String(code).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (clean.length <= 4) return clean;
  return `${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
}

function isConnectingState(data) {
  if (!data) return false;
  if (data.live?.ready) return false;
  if (data.status === 'connecting' || data.status === 'qr_pending') return true;
  if (data.live?.reconnectAttempts > 0) return true;
  return Boolean(data.qr || data.hasQr || data.pairingCode);
}

function IndiaPhoneInput({ value, onChange, disabled }) {
  return (
    <div className="flex overflow-hidden rounded-xl border border-border bg-white">
      <span className="flex items-center gap-2 border-r border-border bg-slate-50 px-3 text-sm text-ink-muted">
        🇮🇳 +91
      </span>
      <input
        className="h-11 flex-1 px-3 text-sm outline-none"
        type="tel"
        inputMode="numeric"
        placeholder="123456789"
        maxLength={10}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
      />
    </div>
  );
}

const STEPS = [
  { n: 1, title: 'Open WhatsApp', desc: 'WhatsApp Business on your phone' },
  { n: 2, title: 'Linked Devices', desc: 'Menu → Linked devices' },
  { n: 3, title: 'Scan QR', desc: 'Point camera at the code below' },
];

export default function Connect() {
  const { bot, setBot, refresh } = useAuth();
  const [mode, setMode] = useState('qr');
  const [qr, setQr] = useState(null);
  const [pairingCode, setPairingCode] = useState(null);
  const [phoneLocal, setPhoneLocal] = useState('');
  const [status, setStatus] = useState(bot);
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [error, setError] = useState('');
  const pollInFlight = useRef(false);
  const modeRef = useRef('qr');
  const linkAttemptRef = useRef(0);
  const recoveryInFlight = useRef(false);

  async function ensureLinkStarted(mode = 'qr', { force = false } = {}) {
    await botApi.start();
    await botApi.prepareLink(mode, { force });
    await poll();
  }

  const applyPollData = useCallback((data) => {
    const activeMode = modeRef.current;
    setStatus(data);
    if (data.live?.ready) {
      setQr(null);
      setPairingCode(null);
      return;
    }
    if (activeMode === 'code') {
      setQr(null);
      setPairingCode(data.pairingCode || null);
    } else {
      setPairingCode(null);
      setQr(data.qr || null);
    }
  }, []);

  const poll = useCallback(async () => {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const data = await botApi.qr();
      applyPollData(data);
      if (data.live?.ready) {
        setBot((prev) => ({ ...prev, status: 'ready', whatsappPhone: data.whatsappPhone }));
        await refresh();
      } else if (data.live?.authenticated && data.status === 'connecting') {
        setBot((prev) => ({ ...prev, status: 'connecting' }));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      pollInFlight.current = false;
    }
  }, [applyPollData, bot, refresh, setBot]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [poll]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await botApi.qr();
        if (cancelled) return;
        applyPollData(data);
        const shouldAutoStart =
          !data.live?.ready &&
          !data.live?.authenticated &&
          (data.status === 'disconnected' || !isConnectingState(data));
        if (shouldAutoStart) {
          try {
            await ensureLinkStarted('qr', { force: data.status === 'disconnected' });
          } catch (startErr) {
            if (!cancelled && startErr?.status !== 408) {
              setError(startErr.message);
            }
          }
        }
      } catch (err) {
        if (!cancelled && err?.status !== 408) setError(err.message);
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();
    return () => { cancelled = true; };
  }, [applyPollData, poll]);

  async function handleStartLinking() {
    setLoading(true);
    setError('');
    linkAttemptRef.current = 0;
    try {
      await ensureLinkStarted(mode);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleModeChange(next) {
    if (next === mode) return;
    modeRef.current = next;
    setMode(next);
    setLoading(true);
    setError('');
    if (next === 'qr') setPairingCode(null);
    else setQr(null);
    try {
      await botApi.prepareLink(next);
      await poll();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleGetPairingCode() {
    if (phoneLocal.length !== 10) {
      setError('Enter a valid 10-digit mobile number');
      return;
    }
    setLoading(true);
    setError('');
    modeRef.current = 'code';
    setMode('code');
    try {
      const data = await botApi.pairingCode(`91${phoneLocal}`);
      setPairingCode(data.pairingCode || null);
      await poll();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleStop() {
    if (!window.confirm('Log out of WhatsApp on Pulse? You will need to scan QR or enter a code to link again.')) return;
    setLoading(true);
    setError('');
    try {
      await botApi.stop();
      setQr(null);
      setPairingCode(null);
      setStatus((prev) => ({ ...prev, status: 'disconnected', live: { ready: false, authenticated: false } }));
      await ensureLinkStarted('qr', { force: true });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const isReady = Boolean(status?.live?.ready);
  const authSyncMs = status?.live?.authSyncMs ?? 0;
  const authSyncStuckMs = 300000;
  const isSyncing =
    !isReady &&
    status?.status !== 'disconnected' &&
    (status?.live?.authPhase === 'syncing' ||
      (status?.status === 'connecting' && status?.live?.authenticated)) &&
    authSyncMs < authSyncStuckMs;
  const isSyncStuck = !isReady && authSyncMs >= authSyncStuckMs && status?.live?.authenticated;
  const linkTiming = status?.live?.linkTiming || {};
  const formatMs = (ms) => (ms != null ? `${(ms / 1000).toFixed(1)}s` : '—');
  const isConnecting = isConnectingState(status);
  const isDisconnected = status?.status === 'disconnected' && !isReady;
  const displayCode = formatPairingCode(pairingCode);
  const busy = loading || bootstrapping;
  const showDisconnect = isReady || isConnecting;

  useEffect(() => {
    if (isReady || qr || bootstrapping || !isConnecting || isSyncing || isSyncStuck || status?.live?.authenticated) {
      return undefined;
    }

    const timer = setTimeout(async () => {
      if (recoveryInFlight.current) return;
      recoveryInFlight.current = true;
      linkAttemptRef.current += 1;
      try {
        setError('');
        await botApi.prepareLink(modeRef.current, { force: true });
        await poll();
      } catch (err) {
        if (linkAttemptRef.current >= 2) {
          setError(err.message || 'Could not generate QR. Try Log out, then Start linking again.');
        }
      } finally {
        recoveryInFlight.current = false;
      }
    }, 50000);

    return () => clearTimeout(timer);
  }, [isReady, qr, bootstrapping, isConnecting, isSyncing, isSyncStuck, poll]);

  return (
    <div className="mx-auto max-w-5xl">
      <SectionHeader
        title="Connect WhatsApp"
        subtitle="Link your WhatsApp Business account to Pulse in under a minute."
        action={
          showDisconnect ? (
            <Button variant="ghost" onClick={handleStop} disabled={loading}>
              <Unplug size={18} />
              {loading ? 'Logging out…' : 'Log out'}
            </Button>
          ) : null
        }
      />

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {!isReady && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant={mode === 'qr' ? 'primary' : 'secondary'}
                size="md"
                onClick={() => handleModeChange('qr')}
                disabled={busy}
              >
                <QrCode size={18} />
                Scan QR
              </Button>
              <Button
                variant={mode === 'code' ? 'primary' : 'secondary'}
                size="md"
                onClick={() => handleModeChange('code')}
                disabled={busy}
              >
                <Smartphone size={18} />
                Link with code
              </Button>
            </div>
          )}

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

          <Card className="flex min-h-[360px] flex-col items-center justify-center text-center">
            {isReady ? (
              <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                <CheckCircle2 size={48} className="mx-auto text-success" />
                <h2 className="mt-4 text-lg font-semibold text-ink">Connected</h2>
                <p className="mt-1 text-sm text-ink-muted">
                  {status.whatsappPhone || status.whatsapp_phone || 'Your number is linked.'}
                </p>
                <Badge tone="live" dot className="mt-4">
                  Live
                </Badge>
              </motion.div>
            ) : mode === 'code' ? (
              <div className="w-full max-w-sm px-4">
                <h2 className="text-lg font-semibold text-ink">Link with phone number</h2>
                <p className="mt-2 text-sm text-ink-muted">
                  Enter your WhatsApp Business number and use the 8-character code on your phone.
                </p>
                <div className="mt-4">
                  <IndiaPhoneInput value={phoneLocal} onChange={setPhoneLocal} disabled={busy} />
                </div>
                <Button
                  className="mt-4 w-full"
                  onClick={handleGetPairingCode}
                  disabled={busy || phoneLocal.length !== 10}
                >
                  {loading ? 'Generating…' : 'Get linking code'}
                </Button>
                {displayCode && (
                  <p className="mt-6 font-mono text-3xl font-bold tracking-[0.2em] text-ink">
                    {displayCode}
                  </p>
                )}
              </div>
            ) : isDisconnected && !qr && !displayCode && !isSyncing ? (
              <div className="flex flex-col items-center px-4">
                <Unplug size={40} className="text-ink-muted" />
                <h2 className="mt-4 text-lg font-semibold text-ink">WhatsApp logged out</h2>
                <p className="mt-2 max-w-sm text-sm text-ink-muted">
                  Pulse is no longer linked to your WhatsApp account. Start linking when you are ready.
                </p>
                <Button className="mt-6" onClick={handleStartLinking} disabled={busy}>
                  <QrCode size={18} />
                  Start linking
                </Button>
              </div>
            ) : qr ? (
              <>
                <img src={qr} alt="Scan with WhatsApp" className="max-w-[280px] rounded-xl border border-border" />
                <p className="mt-4 max-w-md text-sm text-ink-muted">
                  Scan with WhatsApp Business → Linked devices → Link a device
                </p>
              </>
            ) : isSyncing ? (
              <div className="flex flex-col items-center">
                <Loader2 size={32} className="animate-spin text-primary" />
                <h2 className="mt-4 text-lg font-semibold text-ink">Phone linked — finishing setup</h2>
                <p className="mt-1 max-w-sm text-sm text-ink-muted">
                  WhatsApp accepted the link. Pulse is loading your session (usually under a minute).
                </p>
                <Badge tone="warning" className="mt-3 animate-pulseSoft">
                  Syncing
                </Badge>
              </div>
            ) : isSyncStuck ? (
              <div className="flex flex-col items-center px-4">
                <Unplug size={40} className="text-ink-muted" />
                <h2 className="mt-4 text-lg font-semibold text-ink">Setup is taking too long</h2>
                <p className="mt-2 max-w-sm text-sm text-ink-muted">
                  Pulse could not finish loading your session. Generate a fresh QR code to link again.
                </p>
                <Button
                  className="mt-6"
                  disabled={busy}
                  onClick={async () => {
                    setLoading(true);
                    setError('');
                    try {
                      await ensureLinkStarted('qr', { force: true });
                    } catch (err) {
                      setError(err.message);
                    } finally {
                      setLoading(false);
                    }
                  }}
                >
                  <QrCode size={18} />
                  Get new QR
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <Loader2 size={32} className="animate-spin text-primary" />
                <h2 className="mt-4 text-lg font-semibold text-ink">
                  {bootstrapping ? 'Starting session…' : 'Waiting for QR…'}
                </h2>
                <p className="mt-1 text-sm text-ink-muted">
                  Chromium may take up to a minute on first launch. Keep this page open.
                </p>
                {(bootstrapping || isConnecting) && (
                  <Badge tone="warning" className="mt-3 animate-pulseSoft">
                    Connecting
                  </Badge>
                )}
                {!bootstrapping && isConnecting && (
                  <Button
                    className="mt-4"
                    variant="secondary"
                    size="sm"
                    disabled={loading || recoveryInFlight.current}
                    onClick={async () => {
                      setLoading(true);
                      setError('');
                      try {
                        await botApi.prepareLink(mode, { force: true });
                        await poll();
                      } catch (err) {
                        setError(err.message);
                      } finally {
                        setLoading(false);
                      }
                    }}
                  >
                    Refresh QR
                  </Button>
                )}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Connection status</p>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-ink-muted">State</span>
                <Badge tone={isReady ? 'live' : 'neutral'} dot>
                  {status?.status || 'disconnected'}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Session</span>
                <span className="font-medium text-ink">{status?.live?.ready ? 'Active' : 'Inactive'}</span>
              </div>
              {status?.live?.reconnectAttempts > 0 && (
                <div className="flex justify-between">
                  <span className="text-ink-muted">Reconnect tries</span>
                  <span className="font-medium text-ink">{status.live.reconnectAttempts}</span>
                </div>
              )}
              {(linkTiming.launch_ms != null || linkTiming.qr_ms != null || linkTiming.ready_ms != null) && (
                <>
                  <div className="flex justify-between">
                    <span className="text-ink-muted">Launch</span>
                    <span className="font-medium tabular-nums text-ink">{formatMs(linkTiming.launch_ms)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-muted">QR ready</span>
                    <span className="font-medium tabular-nums text-ink">{formatMs(linkTiming.qr_ms)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-muted">Connected</span>
                    <span className="font-medium tabular-nums text-ink">{formatMs(linkTiming.ready_ms)}</span>
                  </div>
                </>
              )}
            </div>
            {status?.lastError && status?.status === 'error' && (
              <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{status.lastError}</p>
            )}
          </Card>

          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Recent activity</p>
            <ul className="mt-3 space-y-2 text-sm text-ink-muted">
              <li>Live status refresh every 1s</li>
              <li>{isReady ? 'Device linked successfully' : 'Awaiting device link'}</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
