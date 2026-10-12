import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, FlaskConical, Send, Trash2 } from 'lucide-react';
import { botsApi } from '../../api/client';
import { Alert, Badge, Button, Card } from '../ds';

function newSessionId() {
  return `s${Date.now().toString(36)}`;
}

/**
 * Talks to the bot through the real reply pipeline (prompt, knowledge, memory)
 * without sending anything on WhatsApp. `draftPrompt` = answer with an unpublished prompt.
 */
export default function Playground({ bot, draftPrompt, onClearDraft }) {
  const [sessionId, setSessionId] = useState(newSessionId);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const threadRef = useRef(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  async function send(e) {
    e.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setText('');
    setError('');
    setMessages((m) => [...m, { role: 'user', content: message }]);
    setBusy(true);
    try {
      const result = await botsApi.playground(bot.id, { sessionId, message, draftPrompt: draftPrompt || undefined });
      setMessages((m) => [
        ...m,
        result.reply
          ? { role: 'assistant', content: result.reply, knowledge: result.knowledge, usedDraft: result.usedDraft }
          : { role: 'system', content: 'The bot treated this as the end of the conversation and sent nothing.' },
      ]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setSessionId(newSessionId());
    setMessages([]);
    setError('');
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <Card padding={false} className="flex h-[36rem] flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <FlaskConical size={16} className="text-ink-muted" />
            <span className="text-sm font-semibold text-ink">Test conversation</span>
            {draftPrompt ? <Badge tone="warning" dot>Unpublished draft prompt</Badge> : <Badge tone="primary">Live prompt</Badge>}
          </div>
          <Button variant="ghost" size="sm" onClick={clear} disabled={busy || !messages.length}>
            <Trash2 size={14} /> Clear
          </Button>
        </div>

        <div ref={threadRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-[#efeae2] px-4 py-4">
          {!messages.length && (
            <p className="mx-auto mt-16 max-w-xs text-center text-sm text-ink-muted">
              Write as a student would. Replies use {draftPrompt ? 'your draft prompt' : 'the published prompt'} and this bot's knowledge — nothing is sent on WhatsApp.
            </p>
          )}
          {messages.map((m, i) =>
            m.role === 'system' ? (
              <p key={i} className="text-center text-xs text-ink-muted">{m.content}</p>
            ) : (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm shadow-sm ${m.role === 'user' ? 'bg-white text-ink' : 'bg-ai-soft text-ink ring-1 ring-ai-ring'}`}>
                  <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">{m.role === 'user' ? 'Student' : 'AI'}</span>
                  <span className="whitespace-pre-wrap">{m.content}</span>
                  {m.knowledge && (
                    <span className="mt-1.5 flex items-center gap-1 text-[11px] text-ink-muted">
                      <BookOpen size={11} /> {m.knowledge.hitCount ? `${m.knowledge.chunks.length} knowledge reference(s)` : 'No knowledge used'}
                    </span>
                  )}
                </div>
              </div>
            )
          )}
          {busy && <p className="text-right text-xs text-ink-muted">AI is typing…</p>}
        </div>

        {error && <Alert tone="error" className="mx-4 mb-2">{error}</Alert>}
        <form onSubmit={send} className="flex gap-2 border-t border-border p-3">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a test message"
            aria-label="Test message"
            className="h-11 min-w-0 flex-1 rounded-xl border border-border px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <Button type="submit" disabled={busy || !text.trim()} aria-label="Send">
            <Send size={16} />
          </Button>
        </form>
      </Card>

      <div className="space-y-4">
        <Card>
          <p className="text-sm font-semibold text-ink">Testing vs live</p>
          <ul className="mt-2 space-y-1.5 text-xs text-ink-muted">
            <li>Prompt: <span className="text-ink">{draftPrompt ? 'draft (not published)' : 'published'}</span></li>
            <li>Knowledge: <span className="text-ink">{bot.knowledgeResourceIds.length} linked document(s)</span></li>
            <li>WhatsApp: <span className="text-ink">nothing is sent</span></li>
            <li>Call-to-Actions: <span className="text-ink">not created</span></li>
          </ul>
          {draftPrompt && (
            <Button variant="secondary" size="sm" className="mt-3 w-full" onClick={onClearDraft}>
              Use published prompt
            </Button>
          )}
        </Card>
        {[...messages].reverse().find((m) => m.knowledge?.chunks?.length) && (
          <Card>
            <p className="mb-2 text-sm font-semibold text-ink">Knowledge used in the last reply</p>
            <ul className="space-y-2">
              {[...messages].reverse().find((m) => m.knowledge?.chunks?.length).knowledge.chunks.map((c, i) => (
                <li key={i} className="rounded-lg bg-slate-50 p-2 text-[11px] text-ink-muted">
                  {c.questionId && <span className="mb-0.5 block font-semibold text-ink">{c.questionId}</span>}
                  {c.text}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
