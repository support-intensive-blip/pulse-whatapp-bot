import React, { useEffect, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { History, RotateCcw } from 'lucide-react';
import { botsApi } from '../../api/client';
import { Alert, Badge, Button, Card, ConfirmDialog, Input, Modal, Spinner } from '../ds';
import { formatISTDateTime } from '../../utils/time';

/**
 * Edit → (test the draft in the playground) → publish. Every publish is a version;
 * any version can be viewed and restored. Leaving with unsaved edits asks first.
 * The draft lives in the parent so switching workspace tabs doesn't lose it.
 */
export default function PromptEditor({ bot, draft, setDraft, onTestDraft }) {
  const [published, setPublished] = useState('');
  const [versions, setVersions] = useState([]);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [restoreTarget, setRestoreTarget] = useState(null);

  const dirty = !loading && draft !== null && draft !== published;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    let cancelled = false;
    botsApi
      .prompt(bot.id)
      .then((data) => {
        if (cancelled) return;
        setPublished(data.content);
        setDraft((current) => (current === null ? data.content : current));
        setVersions(data.versions);
      })
      .catch((err) => setMessage({ tone: 'error', text: err.message }))
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [bot.id, setDraft]);

  // Browser close / reload with unsaved edits.
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  async function publish() {
    setBusy(true);
    setMessage(null);
    try {
      const data = await botsApi.publishPrompt(bot.id, draft, note);
      setPublished(data.content);
      setDraft(data.content);
      setVersions(data.versions);
      setNote('');
      setMessage({ tone: 'success', text: data.changed ? 'Published — new chats use this prompt now.' : 'No changes to publish.' });
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function openVersion(v) {
    try {
      setViewing((await botsApi.promptVersion(bot.id, v.id)).version);
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    }
  }

  async function restore() {
    setBusy(true);
    try {
      const data = await botsApi.restorePrompt(bot.id, restoreTarget.id);
      setPublished(data.content);
      setDraft(data.content);
      setVersions(data.versions);
      setMessage({ tone: 'success', text: `Version #${restoreTarget.id} restored and published.` });
      setRestoreTarget(null);
      setViewing(null);
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  if (loading || draft === null) return <div className="flex justify-center py-12"><Spinner /></div>;

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-4">
        {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)}>{message.text}</Alert>}
        <Card padding={false}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-ink">System prompt</span>
              {dirty ? <Badge tone="warning" dot>Unsaved draft</Badge> : <Badge tone="success">Published</Badge>}
            </div>
            <span className="text-xs tabular-nums text-ink-muted">{draft.length.toLocaleString('en-IN')} chars</span>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="System prompt"
            spellCheck={false}
            className="block min-h-[28rem] w-full resize-y border-0 bg-white px-4 py-3 font-mono text-xs leading-relaxed text-ink focus:outline-none focus:ring-0"
          />
        </Card>
        <p className="text-xs text-ink-muted">
          <code>{'{{name}}'}</code> is replaced by the assistant name. The knowledge base, chat memory and WhatsApp formatting rules are added automatically.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1">
            <Input label="Change note (optional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Added fee-refund policy" />
          </div>
          <Button variant="secondary" onClick={() => setDraft(published)} disabled={!dirty || busy}>
            <RotateCcw size={14} /> Reset draft
          </Button>
          <Button variant="secondary" onClick={() => onTestDraft?.(draft)} disabled={!draft.trim()}>
            Test this draft
          </Button>
          <Button onClick={publish} disabled={!dirty || busy || !draft.trim()}>
            {busy ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
      </div>

      <Card padding={false} className="h-fit">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <History size={16} className="text-ink-muted" />
          <span className="text-sm font-semibold text-ink">Version history</span>
        </div>
        {versions.length ? (
          <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto">
            {versions.map((v, i) => (
              <li key={v.id}>
                <button type="button" onClick={() => openVersion(v)} className="w-full px-4 py-2.5 text-left hover:bg-slate-50">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-ink">#{v.id}</span>
                    {i === 0 && <Badge tone="success">Live</Badge>}
                  </span>
                  <span className="block truncate text-xs text-ink-muted">{v.note || 'No note'}</span>
                  <span className="block text-[11px] text-ink-faint">
                    {formatISTDateTime(v.created_at)}
                    {v.created_by_name ? ` · ${v.created_by_name}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-ink-muted">No versions yet — publish to create the first one.</p>
        )}
      </Card>

      <Modal
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title={`Version #${viewing?.id}`}
        subtitle={viewing ? `${formatISTDateTime(viewing.created_at)}${viewing.note ? ` · ${viewing.note}` : ''}` : ''}
        size="lg"
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => { setDraft(viewing.content); setViewing(null); }}>
              Load into editor
            </Button>
            <Button size="md" onClick={() => setRestoreTarget(viewing)} disabled={viewing?.content === published}>
              Restore & publish
            </Button>
          </>
        }
      >
        <pre className="whitespace-pre-wrap font-mono text-xs text-ink">{viewing?.content}</pre>
      </Modal>

      <ConfirmDialog
        open={Boolean(restoreTarget)}
        title={`Restore version #${restoreTarget?.id}?`}
        message="It becomes the live prompt for this number immediately. The current prompt stays in the history."
        confirmLabel="Restore"
        busy={busy}
        onConfirm={restore}
        onCancel={() => setRestoreTarget(null)}
      />

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        title="Discard unsaved prompt changes?"
        message="Your draft hasn't been published. Leaving now loses it."
        confirmLabel="Discard and leave"
        tone="danger"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </div>
  );
}
