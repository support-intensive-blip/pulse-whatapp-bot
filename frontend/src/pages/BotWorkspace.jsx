import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Bot, RefreshCw } from 'lucide-react';
import { botsApi, knowledgeApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  AiStatusBadge,
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ConnectionBadge,
  Input,
  Spinner,
  Tabs,
  Textarea,
  Toggle,
  formatPhone,
} from '../components/ds';
import PromptEditor from '../components/bot/PromptEditor';
import Playground from '../components/bot/Playground';
import { CopyField, TestResult } from './BotWizard';
import { formatISTDateTime } from '../utils/time';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'prompt', label: 'AI Prompt' },
  { id: 'knowledge', label: 'Knowledge Base' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'testing', label: 'Testing' },
  { id: 'integration', label: 'Integration' },
  { id: 'activity', label: 'Activity Logs' },
];

const AI_STATUS_OPTIONS = [
  { value: 'active', label: 'Active', hint: 'Replies to every chat with AI on' },
  { value: 'testing', label: 'Testing', hint: 'Replies only to test numbers' },
  { value: 'paused', label: 'Paused', hint: 'Stores messages, sends nothing' },
];

function OverviewTab({ bot, onUpdate }) {
  const [busy, setBusy] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  async function setStatus(aiStatus) {
    if (aiStatus === bot.aiStatus) return;
    setBusy(true);
    try {
      await onUpdate({ aiStatus });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <h3 className="text-sm font-semibold text-ink">AI status</h3>
        <p className="mb-4 text-xs text-ink-muted">Applies to this number only. Each chat also has its own AI on/off switch in the Inbox.</p>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="AI status">
          {AI_STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={bot.aiStatus === opt.value}
              disabled={busy || !bot.isActive}
              onClick={() => setStatus(opt.value)}
              className={`rounded-xl border p-3 text-left transition-colors disabled:opacity-50 ${
                bot.aiStatus === opt.value ? 'border-primary bg-primary-soft' : 'border-border bg-white hover:bg-slate-50'
              }`}
            >
              <span className="block text-sm font-semibold text-ink">{opt.label}</span>
              <span className="text-xs text-ink-muted">{opt.hint}</span>
            </button>
          ))}
        </div>
        {bot.aiStatus === 'testing' && (
          <p className="mt-3 text-xs text-ink-muted">
            Test numbers: {bot.testNumbers.length ? bot.testNumbers.map(formatPhone).join(', ') : <span className="text-amber-700">none — add them under Behavior</span>}
          </p>
        )}
      </Card>
      <Card>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between gap-2"><dt className="text-ink-muted">Conversations</dt><dd className="tabular-nums text-ink">{bot.conversationCount}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-ink-muted">Chats with AI on</dt><dd className="tabular-nums text-ink">{bot.aiActiveChats}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-ink-muted">Knowledge docs</dt><dd className="tabular-nums text-ink">{bot.knowledgeResourceIds.length}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-ink-muted">Last message in</dt><dd className="text-right text-ink">{bot.lastInboundAt ? formatISTDateTime(bot.lastInboundAt) : '—'}</dd></div>
        </dl>
        <div className="mt-4 border-t border-border pt-4">
          {bot.isActive ? (
            <Button variant="secondary" size="sm" className="w-full" onClick={() => setConfirmDeactivate(true)}>Deactivate number</Button>
          ) : (
            <Button size="sm" className="w-full" onClick={() => onUpdate({ isActive: true })}>Reactivate number</Button>
          )}
        </div>
      </Card>
      <ConfirmDialog
        open={confirmDeactivate}
        title={`Deactivate ${bot.name}?`}
        message="The bot stops and its webhook is ignored. Chat history and settings are kept, and you can reactivate it any time."
        confirmLabel="Deactivate"
        tone="danger"
        onConfirm={async () => {
          await onUpdate({ isActive: false });
          setConfirmDeactivate(false);
        }}
        onCancel={() => setConfirmDeactivate(false)}
      />
    </div>
  );
}

function KnowledgeTab({ bot, onSaved }) {
  const [resources, setResources] = useState(null);
  const [selected, setSelected] = useState(bot.knowledgeResourceIds);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const loadStatus = useCallback(() => botsApi.knowledgeStatus(bot.id).then(setStatus).catch(() => {}), [bot.id]);

  useEffect(() => {
    knowledgeApi.list().then((d) => setResources(d.resources)).catch((err) => setMessage({ tone: 'error', text: err.message }));
    loadStatus();
  }, [loadStatus]);

  // Poll while an index job is running.
  useEffect(() => {
    if (status?.indexing?.status !== 'indexing') return undefined;
    const t = setInterval(loadStatus, 2000);
    return () => clearInterval(t);
  }, [status, loadStatus]);

  const dirty = [...selected].sort().join() !== [...bot.knowledgeResourceIds].sort().join();

  async function save() {
    setBusy(true);
    try {
      const data = await botsApi.setKnowledge(bot.id, selected);
      onSaved(data.bot);
      setMessage({ tone: 'success', text: 'Saved — re-indexing this bot’s knowledge.' });
      setTimeout(loadStatus, 500);
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const job = status?.indexing;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-4">
        {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)}>{message.text}</Alert>}
        <Card padding={false}>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold text-ink">Documents this bot answers from</span>
            <Link to="/knowledge" className="text-xs font-medium text-primary hover:underline">Manage documents</Link>
          </div>
          {!resources ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : !resources.length ? (
            <p className="px-4 py-6 text-sm text-ink-muted">No documents yet. Add them on the Knowledge Base page.</p>
          ) : (
            <ul className="divide-y divide-border">
              {resources.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <input
                    id={`kb-${r.id}`}
                    type="checkbox"
                    className="h-4 w-4 rounded border-border text-primary"
                    checked={selected.includes(r.id)}
                    onChange={(e) => setSelected((ids) => (e.target.checked ? [...ids, r.id] : ids.filter((id) => id !== r.id)))}
                  />
                  <label htmlFor={`kb-${r.id}`} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block truncate text-sm font-medium text-ink">{r.title}</span>
                    <span className="text-xs text-ink-muted">
                      {r.kind.toUpperCase()} · {r.length.toLocaleString('en-IN')} chars
                      {r.usedBy?.length ? ` · ${r.usedBy.map((b) => b.name).join(', ')}` : ''}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setSelected(bot.knowledgeResourceIds)} disabled={!dirty || busy}>Reset</Button>
          <Button onClick={save} disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
      <Card className="h-fit">
        <p className="text-sm font-semibold text-ink">Index</p>
        {!status ? (
          <Spinner />
        ) : (
          <div className="mt-2 space-y-2 text-sm">
            <p>
              {job?.status === 'indexing' ? (
                <Badge tone="warning" dot>Indexing {job.percent}%</Badge>
              ) : job?.status === 'error' ? (
                <Badge tone="danger" dot>Failed</Badge>
              ) : status.ready ? (
                <Badge tone="success" dot>Ready</Badge>
              ) : (
                <Badge tone="neutral">Empty</Badge>
              )}
            </p>
            <p className="text-xs text-ink-muted">{status.chunkCount.toLocaleString('en-IN')} chunks{status.indexedAt ? ` · ${formatISTDateTime(status.indexedAt)}` : ''}</p>
            {job?.error && <p className="text-xs text-red-700">{job.error}</p>}
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                await botsApi.reindex(bot.id);
                setTimeout(loadStatus, 500);
              }}
              disabled={job?.status === 'indexing' || !bot.knowledgeResourceIds.length}
            >
              <RefreshCw size={14} /> Re-index
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function BehaviorTab({ bot, onUpdate }) {
  const initial = useCallback(
    () => ({
      name: bot.name,
      description: bot.description || '',
      phone: bot.whatsappPhone || '',
      assistantName: bot.assistantName || '',
      defaultAiOn: bot.defaultAiOn,
      batchDelaySeconds: bot.batchDelaySeconds,
      replyDelaySeconds: bot.replyDelaySeconds,
      contextWindowMinutes: bot.contextWindowMinutes,
      testNumbers: bot.testNumbers.join('\n'),
    }),
    [bot]
  );
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e?.target ? e.target.value : e }));
  const phoneChanged = form.phone.replace(/\D/g, '') !== String(bot.whatsappPhone || '');

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await onUpdate({
        name: form.name,
        description: form.description,
        assistantName: form.assistantName,
        defaultAiOn: form.defaultAiOn,
        batchDelaySeconds: Number(form.batchDelaySeconds),
        replyDelaySeconds: Number(form.replyDelaySeconds),
        contextWindowMinutes: Number(form.contextWindowMinutes),
        testNumbers: form.testNumbers.split(/[\s,]+/).map((n) => n.trim()).filter(Boolean),
        ...(phoneChanged ? { phone: form.phone } : {}),
      });
      setMessage({ tone: 'success', text: 'Behavior saved.' });
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="max-w-3xl space-y-6">
      {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)}>{message.text}</Alert>}
      <Card>
        <h3 className="mb-4 text-sm font-semibold text-ink">Identity</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Bot name" value={form.name} onChange={set('name')} />
          <Input label="Assistant name" hint="What the AI calls itself ({{name}} in the prompt)" value={form.assistantName} onChange={set('assistantName')} />
          <Input label="WhatsApp number" value={form.phone} onChange={set('phone')} inputMode="tel" />
          <Textarea label="Description" value={form.description} onChange={set('description')} rows={2} />
        </div>
        {phoneChanged && (
          <Alert tone="warning" className="mt-3">
            Changing the number starts a fresh inbox: chats are stored per number, so existing history stays under {formatPhone(bot.whatsappPhone)}.
          </Alert>
        )}
      </Card>
      <Card>
        <h3 className="mb-4 text-sm font-semibold text-ink">Replies</h3>
        <div className="space-y-4">
          <Toggle
            checked={form.defaultAiOn}
            onChange={set('defaultAiOn')}
            label="AI on for new chats"
            description="Off = new conversations wait for a human until someone turns AI on for that chat."
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <Input label="Batching delay (s)" hint="Combine quick successive messages" type="number" min={0} max={300} value={form.batchDelaySeconds} onChange={set('batchDelaySeconds')} />
            <Input label="Response delay (s)" hint="Pause before sending a reply" type="number" min={0} max={120} value={form.replyDelaySeconds} onChange={set('replyDelaySeconds')} />
            <Input label="Context window (min)" hint="How much recent chat the AI sees" type="number" min={1} max={1440} value={form.contextWindowMinutes} onChange={set('contextWindowMinutes')} />
          </div>
          <div className="rounded-xl bg-slate-50 px-4 py-3 text-xs text-ink-muted">
            <span className="font-medium text-ink">Human handoff:</span> when a team member turns AI off for a chat (or the bot raises a
            Call-to-Action), the AI stays silent in that chat until AI is turned back on.
          </div>
        </div>
      </Card>
      <Card>
        <h3 className="mb-1 text-sm font-semibold text-ink">Test numbers</h3>
        <p className="mb-3 text-xs text-ink-muted">Used when AI status is Testing. One per line, with country code.</p>
        <Textarea value={form.testNumbers} onChange={set('testNumbers')} rows={3} aria-label="Test numbers" />
      </Card>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => setForm(initial())} disabled={busy}>Reset</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save behavior'}</Button>
      </div>
    </form>
  );
}

function IntegrationTab({ bot, onBotChange }) {
  const [creds, setCreds] = useState({ apiKey: '', apiSecret: '', channelId: '', accountId: '', webhookSecret: '' });
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const set = (key) => (e) => setCreds((c) => ({ ...c, [key]: e.target.value }));
  const anyChange = Object.values(creds).some((v) => v.trim());
  const { connection, gallabox } = bot;

  async function run(label, fn) {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="grid max-w-5xl gap-6 lg:grid-cols-2">
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Connection health</h3>
          <ConnectionBadge connected={connection.connected} configured={gallabox.configured} isActive={bot.isActive} />
        </div>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-3"><dt className="text-ink-muted">Last webhook received</dt><dd className="text-right text-ink">{bot.lastInboundAt ? formatISTDateTime(bot.lastInboundAt) : 'Never'}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-ink-muted">Signature check</dt><dd className="text-ink">{gallabox.webhookSecret ? 'On' : <span className="text-amber-700">Off — set a webhook secret</span>}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-ink-muted">Channel ID</dt><dd className="font-mono text-xs text-ink">{gallabox.channelId || '—'}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-ink-muted">Account ID</dt><dd className="font-mono text-xs text-ink">{gallabox.accountId || '—'}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-ink-muted">API key</dt><dd className="font-mono text-xs text-ink">{gallabox.apiKey || '—'}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-ink-muted">API secret</dt><dd className="font-mono text-xs text-ink">{gallabox.apiSecret || '—'}</dd></div>
        </dl>
        {!gallabox.credentialsReadable && (
          <Alert tone="error" className="mt-3">Saved secrets can't be decrypted (the server's encryption key changed). Enter them again.</Alert>
        )}
        {bot.lastError && <Alert tone="error" className="mt-3">{bot.lastError}</Alert>}
        <div className="mt-4">
          <CopyField label="Webhook URL (Gallabox → Settings → Webhooks)" value={connection.webhookUrl} />
          <p className="mt-1.5 text-xs text-ink-muted">Events: Message.Received (optionally Conversation.Create/Update, Message.WA.Status.Failed).</p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => run('test', async () => setTest(await botsApi.testSaved(bot.id)))}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </Button>
          <Button variant="secondary" size="sm" disabled={!!busy || !bot.isActive} onClick={() => run('restart', async () => onBotChange((await botsApi.restart(bot.id)).bot))}>
            <RefreshCw size={14} /> {busy === 'restart' ? 'Reconnecting…' : 'Reconnect'}
          </Button>
        </div>
        <div className="mt-3"><TestResult result={test} /></div>
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-ink">Replace credentials</h3>
        <p className="mb-4 text-xs text-ink-muted">Fill only what you want to change — empty fields keep their saved value. Secrets are write-only.</p>
        {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)} className="mb-3">{message.text}</Alert>}
        <div className="grid gap-3">
          <Input label="API key" value={creds.apiKey} onChange={set('apiKey')} autoComplete="off" />
          <Input label="API secret" type="password" value={creds.apiSecret} onChange={set('apiSecret')} autoComplete="new-password" />
          <Input label="Channel ID" value={creds.channelId} onChange={set('channelId')} autoComplete="off" />
          <Input label="Account ID" value={creds.accountId} onChange={set('accountId')} autoComplete="off" />
          <Input label="Webhook secret" type="password" value={creds.webhookSecret} onChange={set('webhookSecret')} autoComplete="new-password" />
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            disabled={!anyChange || !!busy}
            onClick={() =>
              run('save', async () => {
                const body = Object.fromEntries(Object.entries(creds).filter(([, v]) => v.trim()));
                onBotChange((await botsApi.updateCredentials(bot.id, body)).bot);
                setCreds({ apiKey: '', apiSecret: '', channelId: '', accountId: '', webhookSecret: '' });
                setMessage({ tone: 'success', text: 'Credentials saved and the bot reconnected.' });
              })
            }
          >
            {busy === 'save' ? 'Saving…' : 'Save credentials'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

const ACTION_LABELS = {
  'bot.create': 'Bot created',
  'bot.update': 'Settings changed',
  'bot.credentials_update': 'Credentials replaced',
  'bot.prompt_publish': 'Prompt published',
  'bot.prompt_restore': 'Prompt version restored',
  'bot.knowledge_update': 'Knowledge links changed',
  'bot.restart': 'Reconnected',
  'contacts.import': 'Contacts imported',
};

function describeMeta(entry) {
  const meta = entry.meta || {};
  if (entry.action === 'bot.credentials_update') return meta.fields?.join(', ');
  if (entry.action === 'contacts.import') return `${meta.created || 0} new, ${meta.updated || 0} updated from ${meta.filename}`;
  if (entry.action === 'bot.update') {
    return Object.keys(meta).filter((k) => meta[k] !== undefined && k !== 'phoneChanged' && k !== 'testNumbers').join(', ') + (meta.phoneChanged ? ' · number changed' : '');
  }
  if (entry.action === 'bot.prompt_publish') return `version #${meta.versionId}`;
  return '';
}

function ActivityTab({ bot }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    botsApi.activity(bot.id).then(setData).catch((err) => setError(err.message));
  }, [bot.id]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <div className="flex justify-center py-12"><Spinner /></div>;
  return (
    <Card padding={false} className="max-w-3xl">
      {data.entries.length ? (
        <ul className="divide-y divide-border">
          {data.entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 text-sm">
              <span>
                <span className="font-medium text-ink">{ACTION_LABELS[e.action] || e.action}</span>
                {describeMeta(e) && <span className="text-ink-muted"> · {describeMeta(e)}</span>}
              </span>
              <span className="text-xs text-ink-muted">
                {e.actor_name || 'System'} · {formatISTDateTime(e.created_at)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-6 text-sm text-ink-muted">No activity recorded yet.</p>
      )}
    </Card>
  );
}

export default function BotWorkspace() {
  const { botId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { refresh } = useAuth();
  const [bot, setBot] = useState(null);
  const [error, setError] = useState('');
  const [draftPrompt, setDraftPrompt] = useState(null); // draft sent to the playground
  const [promptDraft, setPromptDraft] = useState(null); // editor contents (null = not loaded)
  const tab = TABS.some((t) => t.id === searchParams.get('tab')) ? searchParams.get('tab') : 'overview';

  useEffect(() => {
    botsApi.get(botId).then((d) => setBot(d.bot)).catch((err) => setError(err.message));
  }, [botId]);

  const setTab = (id) => setSearchParams(id === 'overview' ? {} : { tab: id }, { replace: true });

  async function update(patch) {
    const data = await botsApi.update(bot.id, patch);
    setBot(data.bot);
    refresh({ logoutOnUnauthorized: false });
    return data.bot;
  }

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!bot) return <div className="flex justify-center py-16"><Spinner /></div>;

  return (
    <div className="mx-auto max-w-7xl">
      <Link to="/bots" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft size={14} /> AI Bots
      </Link>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-soft text-primary">
            <Bot size={22} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink">{bot.name}</h1>
            <p className="text-sm text-ink-muted">{formatPhone(bot.whatsappPhone)}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <ConnectionBadge connected={bot.connection.connected} configured={bot.gallabox.configured} isActive={bot.isActive} />
          <AiStatusBadge status={bot.aiStatus} />
        </div>
      </header>

      <div className="mb-6 overflow-x-auto">
        <Tabs value={tab} onChange={setTab} tabs={TABS} className="flex-nowrap" />
      </div>

      {tab === 'overview' && <OverviewTab bot={bot} onUpdate={update} />}
      {tab === 'prompt' && (
        <PromptEditor
          bot={bot}
          draft={promptDraft}
          setDraft={setPromptDraft}
          onTestDraft={(draft) => {
            setDraftPrompt(draft);
            setTab('testing');
          }}
        />
      )}
      {tab === 'knowledge' && <KnowledgeTab bot={bot} onSaved={(b) => setBot((prev) => ({ ...prev, ...b }))} />}
      {tab === 'behavior' && <BehaviorTab bot={bot} onUpdate={update} />}
      {tab === 'testing' && <Playground bot={bot} draftPrompt={draftPrompt} onClearDraft={() => setDraftPrompt(null)} />}
      {tab === 'integration' && <IntegrationTab bot={bot} onBotChange={(b) => { setBot(b); refresh({ logoutOnUnauthorized: false }); }} />}
      {tab === 'activity' && <ActivityTab bot={bot} />}
    </div>
  );
}
