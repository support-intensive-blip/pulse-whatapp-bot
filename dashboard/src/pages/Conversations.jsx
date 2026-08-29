import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { RefreshCw, Search, MessageSquarePlus } from 'lucide-react';
import { dataApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import ChatPanel from '../components/ChatPanel';
import ContactsPanel from '../components/ContactsPanel';
import ExportMenu from '../components/ExportMenu';
import { ChatItem, Badge, Spinner } from '../components/ds';
import { Segmented } from '../components/ui';
import { formatISTDate } from '../utils/time';
import { isContactChat, isContactAiOn } from '../utils/chat';

const LONG_PRESS_MS = 500;

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'enabled', label: 'AI on' },
  { value: 'disabled', label: 'AI off' },
];

export default function Conversations() {
  const { id: selectedId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { bot, loading: authLoading } = useAuth();
  const [sidebarView, setSidebarView] = useState('chats');
  const [chats, setChats] = useState([]);
  const [hint, setHint] = useState('');
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [assistantFilter, setAssistantFilter] = useState('all');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [aiSelectMode, setAiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [exportBusy, setExportBusy] = useState(false);
  const longPressRef = useRef({ timer: null, fired: false });

  const highlightMessageId = searchParams.get('msg') || null;

  const load = useCallback(async (query = search, filter = assistantFilter) => {
    if (authLoading) return;
    try {
      const data = await dataApi.conversations(query, filter);
      setChats(data.chats || []);
      setConnected(data.connected);
      setReconnecting(Boolean(data.reconnecting));
    } catch (err) {
      setHint(err.message);
    } finally {
      setLoading(false);
    }
  }, [assistantFilter, authLoading, search]);

  useEffect(() => {
    if (authLoading) return;
    load();
  }, [authLoading, load]);

  useEffect(() => {
    if (authLoading) return;
    const interval = setInterval(() => load(search, assistantFilter), 30000);
    return () => clearInterval(interval);
  }, [authLoading, assistantFilter, search, load]);

  useEffect(() => {
    if (authLoading || sidebarView !== 'chats') return;
    const t = setTimeout(() => load(search, assistantFilter), 600);
    return () => clearTimeout(t);
  }, [assistantFilter, search, authLoading, load, sidebarView]);

  function updateChatInList(updated) {
    if (updated?.id == null) return;
    const updatedId = String(updated.id);
    setChats((prev) =>
      prev.map((c) => (String(c.id) === updatedId ? { ...c, ...updated } : c))
    );
    if (selectedId && updatedId !== String(selectedId)) {
      navigate(`/conversations/${updated.id}`, { replace: true });
    }
  }

  async function handleSync() {
    setSyncing(true);
    setHint('');
    try {
      const data = await dataApi.syncConversations(search);
      const filtered = await dataApi.conversations(search, assistantFilter);
      setChats(filtered.chats || data.chats || []);
      setConnected(Boolean(filtered.connected ?? data.connected ?? false));
      setReconnecting(Boolean(filtered.reconnecting ?? data.reconnecting));
      const total = (filtered.chats || data.chats || []).length;
      const syncedCount = data.syncedCount ?? (data.synced ? total : 0);

      if (sidebarView === 'contacts' && total > 0) {
        setSidebarView('chats');
      }

      if (data.message) {
        setHint(data.message);
      } else if (!total) {
        setHint(
          data.synced || syncedCount > 0
            ? 'Synced — no chats yet. Message someone on WhatsApp first.'
            : data.reconnecting
              ? 'WhatsApp is reconnecting from your saved session — wait ~30s and try Sync again.'
              : 'Sync failed — open Connect if WhatsApp is not linked yet.'
        );
      } else if (syncedCount > 0 || data.synced) {
        setHint(
          `Synced ${syncedCount > 0 ? syncedCount : total} contact(s) from WhatsApp.`
        );
      } else if (data.reconnecting) {
        setHint('WhatsApp is reconnecting — your session is saved. Wait a moment and try Sync again.');
      } else if (data.connected && total > 0) {
        setHint(`Showing ${total} saved chat(s). Try Sync again in a few seconds if contacts are missing.`);
      } else {
        setHint('Could not sync right now — try again in a few seconds.');
      }
    } catch (err) {
      setHint(err.message);
    } finally {
      setSyncing(false);
      setLoading(false);
    }
  }

  function selectChat(chatId) {
    setSidebarView('chats');
    navigate(`/conversations/${chatId}`);
  }

  function handleBack() {
    navigate('/conversations');
  }

  function handleContactsDone() {
    load(search, assistantFilter);
    setSidebarView('chats');
  }

  async function handleBulkAssistantAll() {
    const enableAll = assistantFilter === 'disabled';
    const action = enableAll ? 'enable AI for all contacts' : 'disable AI for all contacts';
    if (!window.confirm(`${action.charAt(0).toUpperCase() + action.slice(1)}?`)) return;

    setBulkBusy(true);
    setHint('');
    try {
      const result = await dataApi.bulkAssistantAll(enableAll);
      setHint(
        enableAll
          ? `AI enabled for all contacts (${result.updatedCount} chats).`
          : `AI disabled for all contacts (${result.updatedCount} chats).`
      );
      await load(search, assistantFilter);
    } catch (err) {
      setHint(err.message);
    } finally {
      setBulkBusy(false);
    }
  }

  function toggleChatSelected(chatId, checked) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(chatId);
      else next.delete(chatId);
      return next;
    });
  }

  function selectAllContactChats() {
    setSelectedIds(new Set(chats.filter((c) => isContactChat(c)).map((c) => c.id)));
  }

  function exitAiSelectMode() {
    setAiSelectMode(false);
    setSelectedIds(new Set());
  }

  function clearLongPress() {
    if (longPressRef.current.timer) {
      clearTimeout(longPressRef.current.timer);
      longPressRef.current.timer = null;
    }
  }

  function startLongPress(chat, e) {
    if (!isContactChat(chat)) return;
    if (e?.button != null && e.button !== 0) return;
    clearLongPress();
    longPressRef.current.fired = false;
    longPressRef.current.timer = setTimeout(() => {
      longPressRef.current.timer = null;
      longPressRef.current.fired = true;
      setAiSelectMode(true);
      setSelectedIds(new Set([chat.id]));
    }, LONG_PRESS_MS);
  }

  function openAiSelectForChat(chat, e) {
    if (!isContactChat(chat)) return;
    e?.preventDefault?.();
    longPressRef.current.fired = true;
    setAiSelectMode(true);
    setSelectedIds(new Set([chat.id]));
  }

  async function handleBulkAssistantSelected(enable) {
    const ids = chats
      .filter((c) => selectedIds.has(c.id) && isContactChat(c))
      .map((c) => c.id);
    if (!ids.length) {
      setHint('Select at least one contact chat.');
      return;
    }

    setBulkBusy(true);
    setHint('');
    try {
      const results = await Promise.all(ids.map((id) => dataApi.setChatAssistant(id, enable)));
      const updated = results.map((r) => r.chat).filter(Boolean);
      setChats((prev) => {
        const map = new Map(updated.map((c) => [String(c.id), c]));
        return prev.map((c) => {
          const row = map.get(String(c.id));
          return row ? { ...c, ...row } : c;
        });
      });
      setHint(`AI ${enable ? 'enabled' : 'disabled'} for ${ids.length} contact(s).`);
      exitAiSelectMode();
    } catch (err) {
      setHint(err.message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function runExport(ids, format, filename, range = {}) {
    setExportBusy(true);
    setHint('');
    try {
      await dataApi.exportChats(ids, format, filename, range);
      setHint(ids?.length ? `Exported ${ids.length} chat(s).` : 'Chats exported.');
    } catch (err) {
      setHint(err.message);
    } finally {
      setExportBusy(false);
    }
  }

  async function handleExportAll(format, range = {}) {
    await runExport(null, format, 'chats-all', range);
  }

  const showListOnMobile = !selectedId;

  return (
    <div
      className={`-mx-4 -my-4 flex min-h-[calc(100dvh-5rem)] sm:-mx-6 lg:-mx-8 lg:-my-8 wa-app${selectedId ? ' wa-app-chat-open' : ''}`}
    >
      <aside
        className={`wa-sidebar-chats flex w-[380px] min-w-[300px] max-w-[40%] flex-col border-r border-border bg-surface${
          showListOnMobile ? '' : ' wa-sidebar-chats-hidden-mobile'
        }`}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3.5">
          <div>
            <h1 className="text-base font-semibold text-ink">Chats</h1>
            <p className="text-xs text-ink-muted">{chats.length} conversations</p>
          </div>
          <div className="flex items-center gap-1">
            {sidebarView === 'chats' && chats.length > 0 && (
              <ExportMenu
                onExport={handleExportAll}
                disabled={exportBusy}
                compact
                label="Export all chats"
              />
            )}
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-ink-muted transition-colors duration-150 hover:bg-slate-100 hover:text-ink disabled:opacity-50"
              onClick={handleSync}
              disabled={syncing}
              title="Sync from WhatsApp into Pulse (does not push Pulse history to your phone)"
              aria-label="Sync from WhatsApp"
            >
              <RefreshCw size={18} className={syncing ? 'animate-spin' : ''} />
            </button>
          </div>
        </header>
        <p className="border-b border-border px-4 py-2 text-[11px] leading-relaxed text-ink-muted">
          Sync pulls contacts from WhatsApp into Pulse only — it cannot copy Pulse messages onto mobile or WhatsApp Web.
          Export downloads Pulse history; new replies you send here appear on WhatsApp.
        </p>

        <div className="border-b border-border px-3 py-2.5">
          <Segmented
            value={sidebarView}
            onChange={setSidebarView}
            options={[
              { value: 'chats', label: 'Conversations' },
              { value: 'contacts', label: 'Contacts' },
            ]}
          />
        </div>

        {sidebarView === 'chats' && (
          <>
            <div className="border-b border-border px-3 py-2.5">
              <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Chat filters">
                {FILTER_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="tab"
                    aria-selected={assistantFilter === opt.value}
                    onClick={() => setAssistantFilter(opt.value)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
                      assistantFilter === opt.value
                        ? 'bg-primary text-white shadow-sm'
                        : 'bg-slate-100 text-ink-muted hover:bg-slate-200 hover:text-ink'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {(assistantFilter === 'enabled' || assistantFilter === 'disabled') && (
              <div className="border-b border-border px-3 py-2">
                <button
                  type="button"
                  className="w-full rounded-xl bg-slate-50 px-3 py-2 text-xs font-medium text-primary transition-colors duration-150 hover:bg-primary/5 disabled:opacity-50"
                  disabled={bulkBusy}
                  onClick={handleBulkAssistantAll}
                >
                  {bulkBusy
                    ? 'Updating…'
                    : assistantFilter === 'enabled'
                      ? 'Disable AI for all contacts'
                      : 'Enable AI for all contacts'}
                </button>
              </div>
            )}

            {aiSelectMode && (
              <div className="flex flex-wrap items-center gap-2 border-b border-border bg-slate-50 px-3 py-2.5">
                <Badge tone="primary">{selectedIds.size} selected</Badge>
                <button
                  type="button"
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={selectAllContactChats}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="text-xs font-medium text-ink-muted hover:text-ink"
                  onClick={() => setSelectedIds(new Set())}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="text-xs font-medium text-success hover:underline disabled:opacity-50"
                  disabled={bulkBusy || selectedIds.size === 0}
                  onClick={() => handleBulkAssistantSelected(true)}
                >
                  Enable AI
                </button>
                <button
                  type="button"
                  className="text-xs font-medium text-danger hover:underline disabled:opacity-50"
                  disabled={bulkBusy || selectedIds.size === 0}
                  onClick={() => handleBulkAssistantSelected(false)}
                >
                  Disable AI
                </button>
                <button
                  type="button"
                  className="ml-auto text-xs font-medium text-ink-muted hover:text-ink"
                  onClick={exitAiSelectMode}
                >
                  Done
                </button>
              </div>
            )}

            <div className="border-b border-border px-3 py-2.5">
              <div className="relative">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
                />
                <input
                  type="search"
                  placeholder="Search conversations…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search chats"
                  className="h-10 w-full rounded-xl border border-border bg-slate-50 pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint transition-colors duration-150 focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
          </>
        )}

        {hint && (
          <div
            className={`relative border-b px-4 py-2.5 pr-9 text-xs ${
              hint.includes('enabled') ||
              hint.includes('disabled') ||
              hint.includes('Imported') ||
              hint.includes('updated') ||
              hint.includes('Exported') ||
              hint.includes('Synced from WhatsApp')
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}
          >
            {hint}
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-0.5 text-lg leading-none text-current opacity-60 hover:opacity-100"
              onClick={() => setHint('')}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {!connected && sidebarView === 'chats' && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
            {reconnecting || bot?.reconnecting ? (
              <>WhatsApp is reconnecting from your saved session — no new QR needed. Wait ~30s, then Sync.</>
            ) : (
              <>
                WhatsApp offline —{' '}
                <Link to="/connect" className="font-medium text-primary hover:underline">
                  Connect
                </Link>
              </>
            )}
          </div>
        )}

        {sidebarView === 'contacts' ? (
          <ContactsPanel onDone={handleContactsDone} onHint={setHint} />
        ) : (
          <div className="flex-1 overflow-y-auto">
            {loading && chats.length === 0 ? (
              <div className="flex justify-center py-16">
                <Spinner />
              </div>
            ) : chats.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-16 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-ink-muted">
                  <MessageSquarePlus size={28} strokeWidth={1.5} />
                </div>
                <p className="text-sm font-semibold text-ink">No conversations yet</p>
                <p className="mt-1 text-xs text-ink-muted">
                  Sync from WhatsApp or import contacts to get started.
                </p>
                <button
                  type="button"
                  className="mt-4 text-sm font-medium text-primary hover:underline disabled:opacity-50"
                  onClick={handleSync}
                  disabled={syncing}
                >
                  {syncing ? 'Syncing…' : 'Sync from WhatsApp'}
                </button>
                <button
                  type="button"
                  className="mt-2 text-sm font-medium text-ink-muted hover:text-ink"
                  onClick={() => setSidebarView('contacts')}
                >
                  Import contacts
                </button>
              </div>
            ) : (
              chats.map((chat) => {
                const isActive = String(chat.id) === String(selectedId);
                const isChecked = selectedIds.has(chat.id);
                const isContact = isContactChat(chat);
                return (
                  <ChatItem
                    key={chat.id}
                    name={chat.contactName}
                    preview={chat.lastMessage?.preview || `${chat.messageCount} messages`}
                    time={formatISTDate(chat.lastMessage?.timestamp || chat.updatedAt)}
                    active={isActive}
                    selected={isChecked}
                    aiOn={isContactAiOn(chat)}
                    showCheckbox={aiSelectMode && isContact}
                    checked={isChecked}
                    onCheckboxChange={(checked) => toggleChatSelected(chat.id, checked)}
                    onClick={() => {
                      if (longPressRef.current.fired) {
                        longPressRef.current.fired = false;
                        return;
                      }
                      if (aiSelectMode) {
                        if (!isContact) return;
                        toggleChatSelected(chat.id, !isChecked);
                        return;
                      }
                      selectChat(chat.id);
                    }}
                    onMouseDown={(e) => startLongPress(chat, e)}
                    onMouseUp={clearLongPress}
                    onMouseLeave={clearLongPress}
                    onTouchStart={(e) => startLongPress(chat, e)}
                    onTouchEnd={clearLongPress}
                    onTouchMove={clearLongPress}
                    onContextMenu={(e) => openAiSelectForChat(chat, e)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (aiSelectMode && isContact) toggleChatSelected(chat.id, !isChecked);
                        else selectChat(chat.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  />
                );
              })
            )}
          </div>
        )}
      </aside>

      <main className={`wa-main${selectedId ? ' wa-main-visible-mobile' : ''}`}>
        {selectedId ? (
          <ChatPanel
            key={`${selectedId}-${highlightMessageId || 'default'}`}
            chatId={selectedId}
            highlightMessageId={highlightMessageId ? Number(highlightMessageId) : null}
            onChatUpdate={updateChatInList}
            onBack={handleBack}
          />
        ) : (
          <div className="wa-empty-chat">
            <div className="wa-empty-chat-inner">
              <div className="wa-empty-icon" aria-hidden="true">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25">
                  <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
                </svg>
              </div>
              <h2>Pulse for WhatsApp</h2>
              <p>Select a chat to view messages — same layout as WhatsApp Web.</p>
              <p className="wa-empty-hint">Long-press a contact to enable or disable AI.</p>
              <button type="button" className="wa-empty-cta" onClick={() => setSidebarView('contacts')}>
                Manage contacts &amp; bulk AI
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
