import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Database, FileText, Plus, RefreshCw, Search, Upload, X } from 'lucide-react';
import { knowledgeApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Input, Modal, SectionHeader, Spinner, Textarea } from '../components/ds';
import { formatISTDateTime } from '../utils/time';

function IndexBadge({ index }) {
  const job = index?.indexing;
  if (job?.status === 'indexing') return <Badge tone="warning" dot>Indexing {job.percent}%</Badge>;
  if (job?.status === 'error') return <Badge tone="danger" dot>Index failed</Badge>;
  if (index?.ready) return <Badge tone="success" dot>{index.chunkCount.toLocaleString('en-IN')} chunks</Badge>;
  return <Badge tone="neutral">No index</Badge>;
}

const ACCEPT = '.txt,.md,.csv,.json,.pdf';
const ACCEPTED_EXT = /\.(txt|md|csv|json|pdf)$/i;

const BACKEND_LABEL = {
  'supabase-pgvector': 'Supabase (pgvector)',
  'local-hybrid': 'Server disk',
  'pinecone-hybrid-integrated': 'Pinecone',
  'pinecone-hybrid-inference': 'Pinecone',
};

function FileDropZone({ files, onFiles, multiple = false }) {
  const [dragging, setDragging] = useState(false);

  function accept(list) {
    const picked = [...(list || [])].filter((f) => ACCEPTED_EXT.test(f.name));
    if (picked.length) onFiles(multiple ? picked : picked.slice(0, 1));
  }

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        accept(e.dataTransfer.files);
      }}
      className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center ${dragging ? 'border-primary bg-primary-soft' : 'border-border hover:bg-slate-50'}`}
    >
      <Upload size={22} className="text-ink-muted" />
      <span className="text-sm font-medium text-ink">
        {files.length === 1
          ? files[0].name
          : files.length > 1
            ? `${files.length} files selected`
            : `Drop ${multiple ? 'files' : 'a file'} here or click to choose`}
      </span>
      <span className="text-xs text-ink-muted">.txt, .md, .csv, .json or .pdf · up to 20 MB each · Q&amp;A blocks starting with QUESTION_ID: give the most precise answers</span>
      <input type="file" accept={ACCEPT} multiple={multiple} className="sr-only" onChange={(e) => accept(e.target.files)} />
    </label>
  );
}

function AddResourceModal({ open, onClose, bots, onAdded }) {
  const [mode, setMode] = useState('upload');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [files, setFiles] = useState([]);
  const [botIds, setBotIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setMode('upload');
      setTitle('');
      setContent('');
      setFiles([]);
      setBotIds([]);
      setProgress('');
      setError('');
    }
  }, [open]);

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (mode === 'text') {
        const data = await knowledgeApi.createText({ title, content, botIds });
        onAdded([data.resource]);
        return;
      }
      // One document per file, uploaded one at a time; failed files stay selected to retry.
      const added = [];
      const failed = [];
      for (const [i, file] of files.entries()) {
        const prefix = files.length > 1 ? `File ${i + 1}/${files.length}: ` : '';
        setProgress(`${prefix}Reading…`);
        try {
          const data = await knowledgeApi.upload(file, {
            title: files.length === 1 ? title : '',
            botIds,
            onProgress: (page, pages) => setProgress(page < pages ? `${prefix}Reading page ${page}/${pages}…` : `${prefix}Uploading…`),
          });
          added.push(data.resource);
        } catch (err) {
          failed.push({ file, message: err.message });
        }
      }
      if (!failed.length) {
        onAdded(added);
        return;
      }
      setFiles(failed.map((f) => f.file));
      setError(
        `${added.length ? `${added.length} added. ` : ''}Failed: ${failed.map((f) => `${f.file.name} (${f.message})`).join('; ')}`
      );
      if (added.length) onAdded(added, { keepOpen: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  const valid = mode === 'upload' ? files.length > 0 : title.trim() && content.trim();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add knowledge"
      subtitle="Documents belong to the team; choose which bots answer from them."
      size="lg"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>Cancel</Button>
          <Button size="md" onClick={save} disabled={!valid || busy}>
            {busy ? progress || 'Adding…' : mode === 'upload' && files.length > 1 ? `Add ${files.length} files` : 'Add'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <div className="inline-flex rounded-xl border border-border bg-slate-50 p-1">
          {[['upload', 'Upload file'], ['text', 'Paste text']].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${mode === id ? 'bg-white text-ink shadow-sm' : 'text-ink-muted'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {(mode === 'text' || files.length <= 1) && (
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={mode === 'upload' ? 'Defaults to the file name' : 'e.g. Refund policy'} />
        )}
        {mode === 'upload' ? (
          <div className="space-y-2">
            <FileDropZone files={files} onFiles={setFiles} multiple />
            {files.length > 1 && (
              <ul className="space-y-1">
                {files.map((f) => (
                  <li key={`${f.name}-${f.size}`} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-ink">
                    <span className="truncate">{f.name}</span>
                    <button type="button" aria-label={`Remove ${f.name}`} className="text-ink-muted hover:text-ink" onClick={() => setFiles((list) => list.filter((x) => x !== f))}>
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <Textarea label="Content" value={content} onChange={(e) => setContent(e.target.value)} rows={12} className="font-mono text-xs" />
        )}
        {bots.length > 0 && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink">Use it in</legend>
            <div className="flex flex-wrap gap-2">
              {bots.map((bot) => (
                <label key={bot.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${botIds.includes(bot.id) ? 'border-primary bg-primary-soft text-primary' : 'border-border text-ink'}`}>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={botIds.includes(bot.id)}
                    onChange={(e) => setBotIds((ids) => (e.target.checked ? [...ids, bot.id] : ids.filter((id) => id !== bot.id)))}
                  />
                  {bot.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </Modal>
  );
}

function ResourceModal({ resourceId, onClose, onChanged }) {
  const [resource, setResource] = useState(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [progress, setProgress] = useState('');
  const fileInput = useRef(null);

  useEffect(() => {
    if (!resourceId) return;
    setResource(null);
    setError('');
    knowledgeApi
      .get(resourceId)
      .then(({ resource: r }) => {
        setResource(r);
        setTitle(r.title);
        setContent(r.content);
      })
      .catch((err) => setError(err.message));
  }, [resourceId]);

  const dirty = resource && (title !== resource.title || content !== resource.content);

  async function save() {
    setBusy(true);
    setError('');
    try {
      const body = { title };
      if (content !== resource.content) body.content = content;
      await knowledgeApi.update(resource.id, body);
      onChanged('Saved — bots using it are re-indexing.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function replaceFile(file) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      setProgress('Reading…');
      const data = await knowledgeApi.replaceFile(resource.id, file, {
        onProgress: (page, pages) => setProgress(page < pages ? `Reading page ${page}/${pages}…` : 'Uploading…'),
      });
      onChanged(
        data.contentChanged
          ? `“${data.resource.title}” replaced with ${file.name}${data.resource.usedBy?.length ? ' — bots using it are re-indexing.' : '.'}`
          : `${file.name} has the same content — nothing changed.`
      );
    } catch (err) {
      setError(err.message);
      setBusy(false);
    } finally {
      setProgress('');
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const data = await knowledgeApi.remove(resource.id);
      onChanged(`Deleted${data.unlinkedBots.length ? ` and removed from ${data.unlinkedBots.length} bot(s)` : ''}.`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open={Boolean(resourceId)}
      onClose={onClose}
      title={resource?.title || 'Knowledge document'}
      subtitle={resource ? `${resource.kind.toUpperCase()} · updated ${formatISTDateTime(resource.updatedAt)}` : ''}
      size="xl"
      footer={
        resource && (
          <>
            <Button variant="ghost" size="md" className="mr-auto text-danger" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</Button>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => replaceFile(e.target.files?.[0])}
            />
            <Button variant="secondary" size="md" onClick={() => fileInput.current?.click()} disabled={busy}>
              <RefreshCw size={14} /> {progress || 'Replace file'}
            </Button>
            <Button variant="secondary" size="md" onClick={onClose}>Close</Button>
            <Button size="md" onClick={save} disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </>
        )
      }
    >
      {error && <Alert tone="error" className="mb-3">{error}</Alert>}
      {!resource ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <div className="space-y-4">
          {resource.fileBacked && (
            <Alert tone="info">This document mirrors a file shipped with the backend. Editing it or uploading a replacement here detaches it from that file.</Alert>
          )}
          <p className="text-sm text-ink-muted">
            {resource.filename ? `Uploaded from ${resource.filename}. ` : ''}Use <span className="font-medium text-ink">Replace file</span> to upload a new version — every bot using it re-indexes automatically.
          </p>
          <p className="text-sm text-ink-muted">
            Used by: {resource.usedBy?.length ? resource.usedBy.map((b) => b.name).join(', ') : 'no bot yet'}
          </p>
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Textarea label="Content" value={content} onChange={(e) => setContent(e.target.value)} rows={18} className="font-mono text-xs" />
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this document?"
        message="It is removed from every bot that uses it, and their indexes are rebuilt."
        confirmLabel="Delete"
        tone="danger"
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </Modal>
  );
}

export default function Knowledge() {
  const { team, scopeVersion } = useAuth();
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [message, setMessage] = useState(null);
  // Re-indexing starts in the background a moment after a change; poll briefly so it shows up.
  const [watchUntil, setWatchUntil] = useState(0);

  const load = useCallback(() => knowledgeApi.list().then(setData).catch((err) => setMessage({ tone: 'error', text: err.message })), []);

  useEffect(() => {
    load();
  }, [load, scopeVersion, team?.id]);

  // Keep index status fresh while any bot is indexing (or one is about to start).
  useEffect(() => {
    const indexing = data?.bots.some((b) => b.index?.indexing?.status === 'indexing');
    if (!indexing && Date.now() > watchUntil) return undefined;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  }, [data, load, watchUntil]);

  const changed = useCallback((text) => {
    setMessage({ tone: 'success', text });
    setWatchUntil(Date.now() + 10000);
    load();
  }, [load]);

  const storeBackend = data?.bots.find((b) => b.index?.backend)?.index.backend;

  const resources = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = data?.resources || [];
    return q ? list.filter((r) => r.title.toLowerCase().includes(q) || (r.filename || '').toLowerCase().includes(q)) : list;
  }, [data, search]);

  return (
    <div className="mx-auto max-w-6xl">
      <SectionHeader
        eyebrow={team?.name}
        title="Knowledge Base"
        subtitle="Documents your bots answer from. Each bot keeps its own index of the documents linked to it."
        action={<Button onClick={() => setAdding(true)}><Plus size={16} /> Add knowledge</Button>}
      />
      {message && <Alert tone={message.tone} onDismiss={() => setMessage(null)} className="mb-4">{message.text}</Alert>}

      {!data ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
          <div className="min-w-0 space-y-4">
            <div className="relative max-w-sm">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search documents…"
                aria-label="Search documents"
                className="h-10 w-full rounded-xl border border-border bg-white pl-9 pr-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            {!data.resources.length ? (
              <EmptyState icon={BookOpen} title="No knowledge yet" description="Upload FAQs, policies or guides. Bots without knowledge answer from their prompt only." action={<Button onClick={() => setAdding(true)}>Add knowledge</Button>} />
            ) : (
              <Card padding={false}>
                <ul className="divide-y divide-border">
                  {resources.map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => setOpenId(r.id)} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50">
                        <FileText size={18} className="mt-0.5 shrink-0 text-ink-muted" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">{r.title}</span>
                          <span className="block text-xs text-ink-muted">
                            {r.kind.toUpperCase()} · {r.length.toLocaleString('en-IN')} chars · updated {formatISTDateTime(r.updatedAt)}
                          </span>
                        </span>
                        <span className="flex max-w-[45%] flex-wrap justify-end gap-1">
                          {r.usedBy?.length ? r.usedBy.map((b) => <Badge key={b.id} tone="primary">{b.name}</Badge>) : <Badge tone="neutral">Unused</Badge>}
                        </span>
                      </button>
                    </li>
                  ))}
                  {!resources.length && <li className="px-4 py-6 text-sm text-ink-muted">No documents match “{search}”.</li>}
                </ul>
              </Card>
            )}
          </div>

          <Card className="h-fit">
            <p className="text-sm font-semibold text-ink">Bot indexes</p>
            {storeBackend && (
              <p className="mb-3 mt-1 flex items-center gap-1.5 text-xs text-ink-muted">
                <Database size={12} /> Vectors stored in {BACKEND_LABEL[storeBackend] || storeBackend}
              </p>
            )}
            {!storeBackend && <div className="mb-3" />}
            {data.bots.length ? (
              <ul className="space-y-3">
                {data.bots.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-ink">{b.name}</span>
                    <IndexBadge index={b.index} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">No bots in this team yet.</p>
            )}
          </Card>
        </div>
      )}

      <AddResourceModal
        open={adding}
        onClose={() => setAdding(false)}
        bots={data?.bots || []}
        onAdded={(added, { keepOpen = false } = {}) => {
          if (!keepOpen) setAdding(false);
          changed(added.length === 1 ? `“${added[0].title}” added.` : `${added.length} documents added.`);
        }}
      />
      <ResourceModal
        resourceId={openId}
        onClose={() => setOpenId(null)}
        onChanged={(text) => {
          setOpenId(null);
          changed(text);
        }}
      />
    </div>
  );
}
