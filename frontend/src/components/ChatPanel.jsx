import React, { useCallback, useEffect, useRef, useState } from 'react';
import { dataApi } from '../api/client';
import AiAssistantPanel from './AiAssistantPanel';
import AiToggle from './AiToggle';
import ExportMenu from './ExportMenu';
import { EmptyState, Spinner } from './ui';
import { formatISTTime } from '../utils/time';
import { isContactChat, isContactAiOn } from '../utils/chat';

function messageLabel(msg) {
  if (msg.role === 'owner') return msg.source === 'web' ? 'You' : 'You';
  if (msg.role === 'assistant') return 'AI';
  return null;
}

function bubbleClass(msg) {
  if (msg.role === 'owner') return 'wa-bubble wa-bubble-out';
  if (msg.role === 'assistant') return 'wa-bubble wa-bubble-out wa-bubble-ai';
  return 'wa-bubble wa-bubble-in';
}

function mergeMessages(prev, incoming) {
  if (!incoming.length) return prev;
  const map = new Map(prev.map((m) => [m.id, m]));
  for (const msg of incoming) {
    map.set(msg.id, msg);
  }
  return [...map.values()].sort((a, b) => a.id - b.id);
}

function formatBubbleTime(ts) {
  return formatISTTime(ts);
}

function avatarInitial(name) {
  const ch = (name || '?').trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

export default function ChatPanel({ chatId, onChatUpdate, onBack, highlightMessageId = null }) {
  const [chat, setChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [selectedMessageId, setSelectedMessageId] = useState(null);
  const [flashMessageId, setFlashMessageId] = useState(null);
  const threadRef = useRef(null);
  const lastIdRef = useRef(0);
  const stickToBottomRef = useRef(true);
  const highlightRef = useRef(null);
  const onChatUpdateRef = useRef(onChatUpdate);
  onChatUpdateRef.current = onChatUpdate;

  const scrollToBottom = useCallback((behavior = 'smooth') => {
    if (threadRef.current) {
      threadRef.current.scrollTo({
        top: threadRef.current.scrollHeight,
        behavior,
      });
    }
  }, []);

  const load = useCallback(
    async (initial = false) => {
      try {
        const since = initial ? null : lastIdRef.current || null;
        const data = await dataApi.messages(chatId, {
          limit: initial ? 200 : 100,
          since: since || undefined,
        });

        setChat(data.chat);
        onChatUpdateRef.current?.(data.chat);
        setConnected(data.connected);

        if (initial || !since) {
          const list = data.messages || [];
          setMessages(list);
          lastIdRef.current = list.length ? list[list.length - 1].id : 0;
        } else {
          setMessages((prev) => {
            const merged = mergeMessages(prev, data.messages || []);
            if (merged.length) {
              lastIdRef.current = merged[merged.length - 1].id;
            }
            return merged;
          });
        }
      } finally {
        if (initial) setLoading(false);
      }
    },
    [chatId]
  );

  useEffect(() => {
    setLoading(true);
    setMessages([]);
    setSelectedMessageId(null);
    setFlashMessageId(null);
    lastIdRef.current = 0;
    highlightRef.current = highlightMessageId || null;
    load(true);
    const interval = setInterval(() => load(false), 5000);
    return () => clearInterval(interval);
  }, [load, highlightMessageId]);

  useEffect(() => {
    if (!highlightRef.current || !messages.length || loading) return undefined;

    const targetId = highlightRef.current;
    const target = messages.find((msg) => msg.id === targetId);
    if (!target) return undefined;

    stickToBottomRef.current = false;
    const timer = window.setTimeout(() => {
      const el = document.getElementById(`msg-${targetId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setFlashMessageId(targetId);
        window.setTimeout(() => setFlashMessageId(null), 4000);
      }
      highlightRef.current = null;
    }, 120);

    return () => window.clearTimeout(timer);
  }, [messages, loading]);

  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollToBottom(messages.length > 3 ? 'smooth' : 'auto');
    }
  }, [messages, scrollToBottom]);

  function handleThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
  }

  async function handleSend(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    setSendError('');
    try {
      const data = await dataApi.sendMessage(chatId, text);
      setDraft('');
      if (data.message) {
        setMessages((prev) => mergeMessages(prev, [data.message]));
        lastIdRef.current = Math.max(lastIdRef.current, data.message.id);
        stickToBottomRef.current = true;
      }
    } catch (err) {
      setSendError(err.message);
    } finally {
      setSending(false);
    }
  }

  function slugName(name) {
    return (name || 'chat')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
  }

  function handleChatUpdate(updated) {
    setChat((c) => ({ ...c, ...updated }));
    onChatUpdate?.(updated);
  }

  async function handleExport(format, range = {}) {
    const slug = slugName(chat?.contactName);
    await dataApi.exportChats([Number(chatId)], format, `chat-${slug}-${chatId}`, range);
  }

  const selectedMessage = messages.find((m) => m.id === selectedMessageId) || null;

  function handleMessageClick(msg) {
    if (msg.role !== 'assistant') return;
    setSelectedMessageId((current) => (current === msg.id ? null : msg.id));
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="wa-chat-panel flex min-w-0 flex-1 flex-col">
      <header className="wa-chat-header">
        {onBack && (
          <button type="button" className="wa-back-btn" onClick={onBack} aria-label="Back to chats">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        )}
        <div className="wa-chat-avatar">{avatarInitial(chat?.contactName)}</div>
        <div className="wa-chat-header-text">
          <h2 className="wa-chat-title">{chat?.contactName || 'Chat'}</h2>
          <p className="wa-chat-subtitle">
            {connected ? 'online' : 'WhatsApp offline'}
            {isContactAiOn(chat) && (
              <span className="wa-ai-dot wa-ai-dot-inline" title="AI on" aria-label="AI on" />
            )}
          </p>
        </div>
        <ExportMenu onExport={handleExport} compact label="Export this chat" />
        {isContactChat(chat) && (
          <AiToggle
            chatId={chat.id}
            active={Boolean(chat.assistantActive || chat.aiOn)}
            onChange={handleChatUpdate}
          />
        )}
      </header>

      <div className="wa-thread-wrap">
        {loading && !messages.length ? (
          <div className="wa-thread-loading">
            <Spinner />
          </div>
        ) : (
          <div className="wa-thread" ref={threadRef} onScroll={handleThreadScroll}>
            {messages.map((msg) => {
              const label = messageLabel(msg);
              const isSelected = msg.id === selectedMessageId;
              const isFlashing = msg.id === flashMessageId;
              const isInspectable = msg.role === 'assistant';
              return (
                <div
                  key={msg.id}
                  id={`msg-${msg.id}`}
                  className={`${bubbleClass(msg)}${isSelected ? ' wa-bubble-selected' : ''}${isFlashing ? ' wa-bubble-highlight' : ''}${isInspectable ? ' wa-bubble-clickable' : ''}`}
                  onClick={() => handleMessageClick(msg)}
                  onKeyDown={(e) => {
                    if (isInspectable && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      handleMessageClick(msg);
                    }
                  }}
                  role={isInspectable ? 'button' : undefined}
                  tabIndex={isInspectable ? 0 : undefined}
                  title={isInspectable ? 'Show KB chunks for this reply' : undefined}
                >
                  {label && <span className="wa-bubble-sender">{label}</span>}
                  {isInspectable && msg.kbMeta?.chunks?.length > 0 && (
                    <span className="wa-bubble-kb-badge">{msg.kbMeta.chunks.length} KB</span>
                  )}
                  <span className="wa-bubble-text">{msg.content}</span>
                  <span className="wa-bubble-time">{formatBubbleTime(msg.timestamp)}</span>
                </div>
              );
            })}
            {!messages.length && (
              <EmptyState
                title="No messages yet"
                description="Messages from WhatsApp appear here. Pulse may also show history that is not visible on your phone — Export or Send summary to WhatsApp for that context."
              />
            )}
          </div>
        )}
      </div>

      <form className="wa-composer" onSubmit={handleSend}>
        {sendError && <div className="alert error wa-composer-error">{sendError}</div>}
        <div className="wa-composer-row">
          <textarea
            rows={1}
            placeholder={connected ? 'Type a message' : 'Connect WhatsApp to send'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend(e);
              }
            }}
            disabled={!connected || sending}
          />
          <button
            type="submit"
            className="wa-send-btn"
            disabled={!connected || sending || !draft.trim()}
            aria-label="Send"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </form>
      </div>
      <AiAssistantPanel chat={chat} messages={messages} selectedMessage={selectedMessage} />
    </div>
  );
}
