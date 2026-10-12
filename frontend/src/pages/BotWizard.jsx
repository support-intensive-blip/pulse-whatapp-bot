import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Copy, Upload } from 'lucide-react';
import { botsApi, knowledgeApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  Input,
  SectionHeader,
  SoonTag,
  Textarea,
  Toggle,
  formatPhone,
} from '../components/ds';

const STEPS = ['Basic details', 'Gallabox', 'AI configuration', 'Knowledge base', 'Review & activate'];

const PROMPT_STARTER = `You are {{name}}, the WhatsApp assistant for <team / program>.

Who you talk to: <students / parents / ...>
What you help with: <topics>
What you must not do: <promises, fees you can't confirm, ...>

Tone: friendly, brief, plain text. Reply in the language the person writes in.
If the knowledge base does not have the answer, say so and tell them a team member will follow up.`;

export function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-xl border border-border bg-slate-50 px-3 py-2.5 text-xs text-ink">{value || 'Set PUBLIC_BASE_URL on the backend to show the full URL'}</code>
        {value && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              navigator.clipboard?.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
          </Button>
        )}
      </div>
    </div>
  );
}

export function TestResult({ result }) {
  if (!result) return null;
  const tone = !result.ok ? 'error' : result.verified ? 'success' : 'warning';
  return <Alert tone={tone}>{result.message}</Alert>;
}

export default function BotWizard() {
  const { refresh, team } = useAuth();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    name: '',
    phone: '',
    description: '',
    apiKey: '',
    apiSecret: '',
    channelId: '',
    accountId: '',
    webhookSecret: '',
    systemPrompt: PROMPT_STARTER,
    assistantName: '',
    defaultAiOn: true,
    testing: true,
    testNumbers: '',
    batchDelaySeconds: 10,
  });
  const [resources, setResources] = useState([]);
  const [selectedResources, setSelectedResources] = useState([]);
  const [preview, setPreview] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);

  useEffect(() => {
    knowledgeApi.list().then((d) => setResources(d.resources)).catch(() => {});
  }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target?.value ?? e }));
  const phoneDigits = form.phone.replace(/\D/g, '');
  const testNumbers = form.testNumbers.split(/[\s,]+/).map((n) => n.trim()).filter(Boolean);

  const stepValid = [
    form.name.trim() && phoneDigits.length >= 10,
    form.apiKey.trim() && form.apiSecret.trim() && form.channelId.trim(),
    form.systemPrompt.trim().length > 20 && (!form.testing || testNumbers.length > 0),
    true,
    true,
  ];

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(
        await botsApi.testConnection({
          phone: phoneDigits,
          gallabox: { apiKey: form.apiKey, apiSecret: form.apiSecret, channelId: form.channelId, accountId: form.accountId },
        })
      );
    } catch (err) {
      setTest({ ok: false, message: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const { resource } = await knowledgeApi.upload(file);
      setResources((list) => [...list, resource]);
      setSelectedResources((ids) => [...ids, resource.id]);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function showPreview(id) {
    try {
      const { resource } = await knowledgeApi.get(id);
      setPreview(resource);
    } catch (err) {
      setError(err.message);
    }
  }

  async function create(activate) {
    setBusy(true);
    setError('');
    try {
      const { bot } = await botsApi.create({
        name: form.name,
        description: form.description,
        phone: phoneDigits,
        gallabox: {
          apiKey: form.apiKey,
          apiSecret: form.apiSecret,
          channelId: form.channelId,
          accountId: form.accountId,
          webhookSecret: form.webhookSecret,
        },
        systemPrompt: form.systemPrompt,
        assistantName: form.assistantName || form.name,
        defaultAiOn: form.defaultAiOn,
        batchDelaySeconds: Number(form.batchDelaySeconds) || 0,
        testNumbers,
        knowledgeResourceIds: selectedResources,
        activate,
        aiStatus: form.testing ? 'testing' : 'active',
      });
      setCreated(bot);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-6">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="text-success" size={28} />
            <div>
              <h1 className="text-lg font-semibold text-ink">{created.name} is connected</h1>
              <p className="text-sm text-ink-muted">
                {created.aiStatus === 'paused'
                  ? 'Saved paused — it stores messages but does not reply yet.'
                  : created.aiStatus === 'testing'
                    ? 'Testing mode — it only replies to your test numbers.'
                    : 'AI is live on this number.'}
              </p>
            </div>
          </div>
          <div className="mt-6 space-y-4">
            <p className="text-sm text-ink">
              Last step in Gallabox: <span className="text-ink-muted">Settings → Webhooks → Add webhook</span>, events{' '}
              <code className="text-xs">Message.Received</code>, with this URL and the same webhook secret you entered:
            </p>
            <CopyField label="Webhook URL" value={created.connection?.webhookUrl} />
            {!created.connection?.connected && (
              <Alert tone="warning">The bot is not running yet: {created.lastError || 'check the credentials on the Integration tab.'}</Alert>
            )}
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <ButtonLink to={`/bots/${created.id}?tab=testing`}>Open testing playground</ButtonLink>
            <ButtonLink to={`/bots/${created.id}`} variant="secondary">Bot settings</ButtonLink>
            <ButtonLink to="/bots" variant="ghost">All bots</ButtonLink>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <SectionHeader eyebrow={team?.name} title="Connect WhatsApp number" subtitle="Each number becomes its own AI bot." />

      <ol className="mb-6 grid grid-cols-5 gap-2" aria-label="Wizard steps">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={i === step ? 'step' : undefined}>
            <button
              type="button"
              onClick={() => i < step && setStep(i)}
              disabled={i > step}
              className="w-full text-left"
            >
              <span className={`block h-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-slate-200'}`} />
              <span className={`mt-2 hidden text-xs sm:block ${i === step ? 'font-semibold text-ink' : 'text-ink-muted'}`}>
                {i + 1}. {label}
              </span>
            </button>
          </li>
        ))}
      </ol>

      {error && <Alert tone="error" onDismiss={() => setError('')} className="mb-4">{error}</Alert>}

      <Card className="p-5 sm:p-6">
        <h2 className="mb-4 text-base font-semibold text-ink">{STEPS[step]}</h2>

        {step === 0 && (
          <div className="space-y-4">
            <Input label="Bot name" value={form.name} onChange={set('name')} placeholder="e.g. Admissions Bot" autoFocus />
            <Input
              label="WhatsApp Business number"
              hint="With country code, digits only — e.g. 919876543210"
              value={form.phone}
              onChange={set('phone')}
              inputMode="tel"
            />
            <Textarea label="Description" value={form.description} onChange={set('description')} rows={2} placeholder="What this number is for (optional)" />
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">
              From Gallabox: <span className="text-ink">Settings → API keys</span> for the key and secret, and the channel's settings page for its Channel ID.
              Secrets are encrypted and never shown again — only the last 4 characters.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="API key" value={form.apiKey} onChange={set('apiKey')} autoComplete="off" />
              <Input label="API secret" type="password" value={form.apiSecret} onChange={set('apiSecret')} autoComplete="new-password" />
              <Input label="Channel ID" value={form.channelId} onChange={set('channelId')} autoComplete="off" />
              <Input label="Account ID" hint="Optional — needed to verify the key" value={form.accountId} onChange={set('accountId')} autoComplete="off" />
            </div>
            <Input
              label="Webhook secret"
              hint="Choose a secret and enter the same value on the Gallabox webhook. Required in production."
              type="password"
              value={form.webhookSecret}
              onChange={set('webhookSecret')}
              autoComplete="new-password"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" size="md" onClick={runTest} disabled={testing || !stepValid[1]}>
                {testing ? 'Testing…' : 'Test connection'}
              </Button>
            </div>
            <TestResult result={test} />
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <Textarea
              label="System prompt"
              hint="How this bot behaves. {{name}} is replaced by the assistant name. You can keep editing and version it later."
              value={form.systemPrompt}
              onChange={set('systemPrompt')}
              rows={12}
              className="font-mono text-xs"
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Assistant name" hint="What the bot calls itself" value={form.assistantName} onChange={set('assistantName')} placeholder={form.name || 'e.g. Priya'} />
              <Input
                label="Message batching delay (seconds)"
                hint="Waits this long to combine quick successive messages into one reply"
                type="number"
                min={0}
                max={300}
                value={form.batchDelaySeconds}
                onChange={set('batchDelaySeconds')}
              />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-dashed border-border px-4 py-3">
              <span className="text-sm text-ink-muted">AI model selection</span>
              <SoonTag />
            </div>
            <Toggle
              checked={form.defaultAiOn}
              onChange={(v) => setForm((f) => ({ ...f, defaultAiOn: v }))}
              label="AI on for new chats"
              description="Off = new conversations start with a human, and AI is switched on per chat."
            />
            <Toggle
              checked={form.testing}
              onChange={(v) => setForm((f) => ({ ...f, testing: v }))}
              label="Start in testing mode"
              description="Only the numbers below get AI replies; everyone else's messages are stored without a reply."
            />
            {form.testing && (
              <Textarea
                label="Test numbers"
                hint="One per line or comma-separated, with country code"
                value={form.testNumbers}
                onChange={set('testNumbers')}
                rows={2}
              />
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">Pick the team documents this bot answers from. Each bot has its own index; documents can be shared between bots.</p>
            {resources.length ? (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {resources.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                    <input
                      type="checkbox"
                      id={`res-${r.id}`}
                      checked={selectedResources.includes(r.id)}
                      onChange={(e) =>
                        setSelectedResources((ids) => (e.target.checked ? [...ids, r.id] : ids.filter((id) => id !== r.id)))
                      }
                      className="h-4 w-4 rounded border-border text-primary"
                    />
                    <label htmlFor={`res-${r.id}`} className="min-w-0 flex-1 cursor-pointer">
                      <span className="block truncate text-sm font-medium text-ink">{r.title}</span>
                      <span className="text-xs text-ink-muted">
                        {r.kind.toUpperCase()} · {r.length.toLocaleString('en-IN')} chars
                        {r.usedBy?.length ? ` · used by ${r.usedBy.map((b) => b.name).join(', ')}` : ''}
                      </span>
                    </label>
                    <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => showPreview(r.id)}>
                      Preview
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-ink-muted">No knowledge documents in this team yet.</p>
            )}
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-white px-4 py-2.5 text-sm font-medium text-ink hover:bg-slate-50">
              <Upload size={16} /> {uploading ? 'Uploading…' : 'Upload document (.txt, .md, .pdf)'}
              <input type="file" accept=".txt,.md,.csv,.json,.pdf" className="sr-only" onChange={handleUpload} disabled={uploading} />
            </label>
            {preview && (
              <div className="rounded-xl border border-border">
                <div className="flex items-center justify-between border-b border-border px-4 py-2">
                  <span className="text-sm font-medium text-ink">{preview.title}</span>
                  <button type="button" className="text-xs text-ink-muted hover:text-ink" onClick={() => setPreview(null)}>Close</button>
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3 text-xs text-ink">{preview.content.slice(0, 4000)}{preview.content.length > 4000 ? '\n…' : ''}</pre>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-[9rem_1fr] gap-y-2 rounded-xl bg-slate-50 p-4">
              <dt className="text-ink-muted">Bot</dt>
              <dd className="font-medium text-ink">{form.name}</dd>
              <dt className="text-ink-muted">Number</dt>
              <dd className="text-ink">{formatPhone(phoneDigits)}</dd>
              <dt className="text-ink-muted">Gallabox channel</dt>
              <dd className="font-mono text-xs text-ink">{form.channelId}</dd>
              <dt className="text-ink-muted">Webhook secret</dt>
              <dd className="text-ink">{form.webhookSecret ? 'Set' : <span className="text-amber-700">Not set (required in production)</span>}</dd>
              <dt className="text-ink-muted">Prompt</dt>
              <dd className="text-ink">{form.systemPrompt.trim().length.toLocaleString('en-IN')} characters</dd>
              <dt className="text-ink-muted">Knowledge</dt>
              <dd className="text-ink">{selectedResources.length} document(s)</dd>
              <dt className="text-ink-muted">AI on new chats</dt>
              <dd className="text-ink">{form.defaultAiOn ? 'Yes' : 'No'}</dd>
              <dt className="text-ink-muted">Mode</dt>
              <dd className="text-ink">{form.testing ? `Testing (${testNumbers.length} number${testNumbers.length === 1 ? '' : 's'})` : 'Live'}</dd>
            </dl>
            {test ? <TestResult result={test} /> : <Alert tone="info">Connection not tested yet — you can test from step 2 or later on the Integration tab.</Alert>}
            <p className="text-ink-muted">
              After creating, try it in the <span className="text-ink">testing playground</span> — it uses this prompt and knowledge without sending anything on WhatsApp.
            </p>
          </div>
        )}
      </Card>

      <div className="mt-4 flex flex-wrap justify-between gap-2">
        <div>
          {step === 0 ? (
            <Link to="/bots" className="inline-flex h-11 items-center px-2 text-sm text-ink-muted hover:text-ink">Cancel</Link>
          ) : (
            <Button variant="secondary" onClick={() => setStep((s) => s - 1)} disabled={busy}>Back</Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep((s) => s + 1)} disabled={!stepValid[step]}>Continue</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => create(false)} disabled={busy}>Save paused</Button>
              <Button onClick={() => create(true)} disabled={busy}>
                {busy ? 'Creating…' : form.testing ? 'Activate in testing mode' : 'Activate bot'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
