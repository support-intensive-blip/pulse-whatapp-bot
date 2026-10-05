import React, { useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  Brain,
  User,
  Star,
  MessageSquare,
  Zap,
  TrendingUp,
  BookOpen,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Card } from './ds';
import { dataApi } from '../api/client';
import { isContactAiOn } from '../utils/chat';

function contextModeLabel(mode) {
  switch (mode) {
    case 'intensive':
      return 'KB';
    case 'guru':
      return 'Guru';
    case 'casual':
      return 'Casual chat';
    default:
      return mode || 'Unknown';
  }
}

function modeLabel(mode) {
  switch (mode) {
    case 'kb':
      return 'KB matched';
    case 'kb_miss':
    case 'kb_not_found':
      return 'KB not found';
    case 'kb_topic_mismatch':
      return 'KB topic mismatch';
    case 'prompt_only':
      return 'Prompt only';
    case 'kb_not_ready':
      return 'KB not indexed';
    case 'brief_ack':
      return 'Brief ack';
    case 'no_prompt':
      return 'No prompt configured';
    default:
      return mode || 'Unknown';
  }
}

function kbEmptyMessage(kbMeta) {
  const reason = kbMeta?.reason;
  if (kbMeta?.mode === 'kb_miss') {
    return 'KB not found — vector search returned no matching chunks for this query.';
  }
  if (kbMeta?.mode === 'kb_topic_mismatch') {
    return 'Retrieved chunks did not align with the query topic — bot was told not to invent an answer.';
  }
  if (reason === 'team_kb_empty' || reason === 'kb_not_indexed' || kbMeta?.mode === 'kb_not_found') {
    return 'KB not found — no knowledge base chunks are indexed for this bot’s namespace.';
  }
  if (kbMeta?.mode === 'kb_not_ready') {
    return 'KB not found — the knowledge base is not indexed yet.';
  }
  if (kbMeta?.mode === 'prompt_only') {
    return 'KB not searched — reply used system prompt only.';
  }
  return 'KB not found — no chunks were attached to this reply.';
}

function modeTone(mode) {
  if (mode === 'kb') return 'success';
  if (mode === 'kb_miss' || mode === 'kb_topic_mismatch' || mode === 'kb_not_found' || mode === 'kb_not_ready') {
    return 'warning';
  }
  return 'neutral';
}

function ChunkCard({ chunk }) {
  const [open, setOpen] = useState(false);
  const preview = chunk.preview || chunk.text || '';

  return (
    <div className="rounded-lg border border-border bg-slate-50/80 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink">
            Chunk #{chunk.rank ?? chunk.chunkId}
            {chunk.neighborOf && (
              <span className="ml-2 font-normal text-amber-700">adjacent</span>
            )}
            {typeof chunk.score === 'number' && (
              <span className="ml-2 font-normal text-ink-muted">score {chunk.score}</span>
            )}
          </p>
          <p className="mt-1 line-clamp-3 text-xs text-ink-muted">{preview}</p>
        </div>
        {chunk.text && chunk.text.length > preview.length && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded p-1 text-ink-muted hover:bg-white"
            aria-label={open ? 'Collapse chunk' : 'Expand chunk'}
          >
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>
      {open && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 text-[11px] leading-relaxed text-ink">
          {chunk.text}
          {chunk.truncated ? '\n\n[truncated in storage]' : ''}
        </pre>
      )}
    </div>
  );
}

export default function AiAssistantPanel({ chat, messages = [], selectedMessage = null }) {
  const [summary, setSummary] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [summarizeBusy, setSummarizeBusy] = useState(false);
  const [sendSummaryBusy, setSendSummaryBusy] = useState(false);
  const [escalateBusy, setEscalateBusy] = useState(false);

  useEffect(() => {
    setSummary('');
    setActionMessage('');
    setActionError('');
  }, [chat?.id]);

  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const lastAiMsg = [...messages].reverse().find((m) => m.role === 'assistant');
  const focusMessage =
    selectedMessage?.role === 'assistant'
      ? selectedMessage
      : lastAiMsg;
  const kbMeta = focusMessage?.kbMeta || null;

  async function handleSummarize() {
    if (!chat?.id || summarizeBusy) return;
    setSummarizeBusy(true);
    setActionError('');
    setActionMessage('');
    try {
      const data = await dataApi.summarizeChat(chat.id);
      setSummary(data.summary || '');
      setActionMessage(`Summary ready for ${data.contactName || 'this chat'}.`);
    } catch (err) {
      setActionError(err.message || 'Failed to summarize conversation.');
      setSummary('');
    } finally {
      setSummarizeBusy(false);
    }
  }

  async function handleSendSummaryToWhatsApp() {
    if (!chat?.id || sendSummaryBusy) return;
    const confirmed = window.confirm(
      'Send one new WhatsApp message with a Pulse conversation summary?\n\nThis cannot restore old Pulse messages as past bubbles on mobile — it only posts a new summary.'
    );
    if (!confirmed) return;

    setSendSummaryBusy(true);
    setActionError('');
    setActionMessage('');
    try {
      const data = await dataApi.sendSummaryToWhatsApp(chat.id);
      if (data.summary) setSummary(data.summary);
      setActionMessage(
        `Summary sent to WhatsApp for ${data.contactName || 'this chat'}. Check that chat on your phone for the new message.`
      );
    } catch (err) {
      setActionError(err.message || 'Failed to send summary to WhatsApp.');
    } finally {
      setSendSummaryBusy(false);
    }
  }

  async function handleEscalate() {
    if (!chat?.id || escalateBusy) return;
    setEscalateBusy(true);
    setActionError('');
    setActionMessage('');
    try {
      const data = await dataApi.escalateChat(chat.id);
      setActionMessage(data.message || 'Added to Call to Action.');
      if (data.item?.id) {
        setActionMessage(
          (data.message || 'Added to Call to Action.') +
            ' Open Call to Action to review it.'
        );
      }
    } catch (err) {
      setActionError(err.message || 'Failed to escalate.');
    } finally {
      setEscalateBusy(false);
    }
  }
  const aiOn = chat ? isContactAiOn(chat) : false;

  const precedingUserMsg = useMemo(() => {
    if (!focusMessage) return lastUserMsg;
    const idx = messages.findIndex((m) => m.id === focusMessage.id);
    if (idx <= 0) return lastUserMsg;
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return messages[i];
    }
    return lastUserMsg;
  }, [focusMessage, lastUserMsg, messages]);

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-surface xl:flex">
      <div className="border-b border-border px-4 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-soft text-primary">
            <Sparkles size={16} />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">AI Assistant</p>
            <p className="text-xs text-ink-muted">Per-contact context & KB</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone={aiOn ? 'success' : 'neutral'} dot>
            {aiOn ? 'AI Active' : 'AI Off'}
          </Badge>
          {chat?.assistantPinned && <Badge tone="primary">Pinned</Badge>}
          {(chat?.conversationMode || kbMeta?.contextMode) && (
            <Badge tone={kbMeta?.contextMode === 'intensive' ? 'primary' : 'neutral'}>
              {contextModeLabel(kbMeta?.contextMode || chat?.conversationMode)}
            </Badge>
          )}
        </div>
        {(chat?.contextTopic || kbMeta?.contextTopic) && (
          <p className="mt-2 text-xs text-ink-muted">
            Topic: <span className="text-ink">{kbMeta?.contextTopic || chat?.contextTopic}</span>
          </p>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <Card padding className="!p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
            <Brain size={14} />
            {selectedMessage?.role === 'assistant' ? 'Selected AI reply' : 'Latest AI reply'}
          </div>
          <p className="mt-2 text-sm text-ink">
            {focusMessage?.content?.slice(0, 220) ||
              'AI will draft contextual replies once the conversation has messages.'}
          </p>
          {precedingUserMsg?.content && (
            <p className="mt-2 text-xs text-ink-muted">
              User asked: {precedingUserMsg.content.slice(0, 120)}
              {precedingUserMsg.content.length > 120 ? '…' : ''}
            </p>
          )}
        </Card>

        <Card padding className="!p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
              <BookOpen size={14} />
              Knowledge retrieved
            </div>
            {kbMeta?.mode && (
              <Badge tone={modeTone(kbMeta.mode)}>{modeLabel(kbMeta.mode)}</Badge>
            )}
          </div>

          {!focusMessage?.role || focusMessage.role !== 'assistant' ? (
            <p className="mt-2 text-sm text-ink-muted">
              Click an AI message in the chat to inspect KB chunks used for that reply.
            </p>
          ) : !kbMeta ? (
            <p className="mt-2 text-sm text-ink-muted">
              No KB debug data for this message (sent before chunk logging was enabled).
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {kbMeta.contextMode && (
                <p className="text-xs text-ink-muted">
                  Context: <span className="text-ink">{contextModeLabel(kbMeta.contextMode)}</span>
                  {kbMeta.contextTopic ? ` · topic: ${kbMeta.contextTopic}` : ''}
                </p>
              )}
              {kbMeta.query && (
                <p className="text-xs text-ink-muted">
                  Query: <span className="text-ink">{kbMeta.query}</span>
                </p>
              )}
            {kbMeta.focusedQuery && (
                <p className="text-xs text-ink-muted">
                  Focused search: <span className="text-ink">{kbMeta.focusedQuery}</span>
                </p>
              )}
              {kbMeta.searchQuery && kbMeta.searchQuery !== kbMeta.query && (
                <p className="text-xs text-ink-muted">
                  Context search: <span className="text-ink">{kbMeta.searchQuery}</span>
                </p>
              )}
              <p className="text-xs text-ink-muted">
                {kbMeta.chunkCount ?? kbMeta.chunks?.length ?? 0} chunk(s)
                {typeof kbMeta.hitCount === 'number' ? ` from ${kbMeta.hitCount} hit(s)` : ''}
                {typeof kbMeta.topK === 'number' && kbMeta.topK > 0 ? ` · topK ${kbMeta.topK}` : ''}
              </p>
              {kbMeta.chunks?.length ? (
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {kbMeta.chunks.map((chunk) => (
                    <ChunkCard key={`${chunk.rank}-${chunk.chunkId}`} chunk={chunk} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-ink-muted">{kbEmptyMessage(kbMeta)}</p>
              )}
            </div>
          )}
        </Card>

        <Card padding className="!p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
            <User size={14} />
            Contact details
          </div>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">Name</dt>
              <dd className="font-medium text-ink">{chat?.contactName || '—'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">Phone</dt>
              <dd className="font-medium text-ink">{chat?.contactPhone || '—'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-muted">Messages</dt>
              <dd className="font-medium text-ink">{chat?.messageCount ?? 0}</dd>
            </div>
          </dl>
        </Card>

        <Card padding className="!p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
            <Star size={14} />
            Lead score
          </div>
          <div className="mt-2 flex items-end gap-2">
            <span className="text-2xl font-semibold text-ink">
              {Math.min(100, (chat?.messageCount || 0) * 8 + (aiOn ? 20 : 0))}
            </span>
            <span className="pb-1 text-xs text-ink-muted">/ 100</span>
          </div>
        </Card>

        <Card padding className="!p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
            <TrendingUp size={14} />
            Sentiment
          </div>
          <Badge tone="success" className="mt-2">
            Positive
          </Badge>
          <p className="mt-2 text-xs text-ink-muted">
            Last inbound: {lastUserMsg?.content?.slice(0, 80) || 'No inbound messages yet.'}
          </p>
        </Card>

        <Card padding className="!p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Confidence
            </span>
            <span className="text-sm font-semibold text-primary">
              {kbMeta?.mode === 'kb' && kbMeta.chunks?.length
                ? `${Math.min(99, 55 + kbMeta.chunks.length * 8)}%`
                : kbMeta?.mode === 'kb_miss'
                  ? '42%'
                  : '—'}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{
                width:
                  kbMeta?.mode === 'kb' && kbMeta.chunks?.length
                    ? `${Math.min(99, 55 + kbMeta.chunks.length * 8)}%`
                    : kbMeta?.mode === 'kb_miss'
                      ? '42%'
                      : '0%',
              }}
            />
          </div>
        </Card>
      </div>

      <div className="border-t border-border p-4">
        <p className="mb-2 text-xs font-medium text-ink-muted">Quick actions</p>
        {actionError && (
          <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-700">
            {actionError}
          </div>
        )}
        {actionMessage && !actionError && (
          <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-800">
            {actionMessage}
            {/Call to Action/i.test(actionMessage) && (
              <>
                {' '}
                <Link to="/actions" className="font-medium underline">
                  View Call to Action
                </Link>
              </>
            )}
          </div>
        )}
        {summary && (
          <div className="mb-3 rounded-lg border border-border bg-slate-50 p-2.5">
            <p className="mb-1 text-xs font-semibold text-ink">Conversation summary</p>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">{summary}</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handleSummarize}
            disabled={!chat?.id || summarizeBusy || sendSummaryBusy}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-2 py-2 text-xs font-medium text-ink hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <MessageSquare size={14} />
            {summarizeBusy ? 'Summarizing…' : 'Summarize'}
          </button>
          <button
            type="button"
            onClick={handleEscalate}
            disabled={!chat?.id || escalateBusy}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-2 py-2 text-xs font-medium text-ink hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Zap size={14} />
            {escalateBusy ? 'Escalating…' : 'Escalate'}
          </button>
        </div>
        <button
          type="button"
          onClick={handleSendSummaryToWhatsApp}
          disabled={!chat?.id || sendSummaryBusy || summarizeBusy}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2 py-2 text-xs font-medium text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
          title="Posts one new WhatsApp message. Cannot restore old Pulse bubbles on mobile."
        >
          <MessageSquare size={14} />
          {sendSummaryBusy ? 'Sending summary…' : 'Send summary to WhatsApp'}
        </button>
        <p className="mt-2 text-[10px] leading-relaxed text-ink-muted">
          Pulse history stays in Pulse/Export. WhatsApp only shows native chat bubbles; this sends one new summary message.
        </p>
      </div>
    </aside>
  );
}
