import React, { useEffect, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, Copy, Info } from 'lucide-react';
import { Badge, Button, Drawer, Tabs } from '../ds';

const SEVERITY = {
  error: { icon: AlertCircle, tone: 'danger', className: 'border-red-200 bg-red-50/60' },
  warning: { icon: AlertTriangle, tone: 'warning', className: 'border-amber-200 bg-amber-50/60' },
  info: { icon: Info, tone: 'primary', className: 'border-border bg-slate-50' },
  success: { icon: CheckCircle2, tone: 'success', className: 'border-emerald-200 bg-emerald-50/60' },
};

const AREA_LABELS = {
  knowledge: 'Knowledge base',
  prompt: 'Prompt',
  temperature: 'Temperature',
  retrieval: 'Retrieval',
  model: 'Model',
  overall: 'Overall',
};

const MODE_LABELS = {
  kb: 'KB hit',
  kb_miss: 'KB miss',
  kb_topic_mismatch: 'Topic mismatch',
  brief_ack: 'Brief acknowledgement',
  prompt_only: 'Prompt only',
  kb_not_found: 'KB not indexed',
};

function Row({ label, children }) {
  return (
    <div className="flex gap-3 py-1.5 text-xs">
      <span className="w-36 shrink-0 text-ink-muted">{label}</span>
      <span className="min-w-0 flex-1 break-words text-ink">{children ?? '—'}</span>
    </div>
  );
}

function CopyButton({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Copy size={13} /> {copied ? 'Copied' : label}
    </Button>
  );
}

function Pre({ children, className = '' }) {
  return (
    <pre className={`whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-ink ${className}`}>
      {children}
    </pre>
  );
}

function ChunkCard({ chunk, muted = false }) {
  const [open, setOpen] = useState(false);
  const scores = [
    chunk.score != null && `score ${chunk.score}`,
    chunk.semanticScore != null && `semantic ${chunk.semanticScore}`,
    chunk.sparseScore != null && `keyword ${chunk.sparseScore}`,
  ].filter(Boolean);
  return (
    <li className={`rounded-xl border border-border p-3 ${muted ? 'bg-slate-50' : 'bg-white'}`}>
      <div className="flex flex-wrap items-center gap-2">
        {chunk.rank != null && <span className="text-[11px] font-semibold text-ink-muted">#{chunk.rank}</span>}
        <span className="text-xs font-semibold text-ink">{chunk.questionId || 'Untagged chunk'}</span>
        {chunk.section && <Badge>{chunk.section}</Badge>}
        <span className="ml-auto text-[11px] text-ink-muted">{scores.join(' · ')}</span>
      </div>
      {chunk.canonicalQuestion && (
        <p className="mt-2 text-sm text-ink">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Canonical question</span>
          <br />
          {chunk.canonicalQuestion}
        </p>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
      >
        <ChevronDown size={12} className={open ? 'rotate-180' : ''} /> {open ? 'Hide' : 'Show'} variations, answer and raw chunk
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          {chunk.variations?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Variations ({chunk.variations.length})</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink">
                {chunk.variations.map((v, i) => <li key={i}>{v}</li>)}
              </ul>
            </div>
          )}
          {chunk.answer && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Answer</p>
              <p className="mt-1 text-ink">{chunk.answer}</p>
            </div>
          )}
          <Pre>{chunk.text}{chunk.truncated ? '\n… (truncated)' : ''}</Pre>
        </div>
      )}
    </li>
  );
}

function DiagnosisTab({ trace }) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-slate-50 p-3 text-xs">
        <p className="text-ink-muted">Student asked</p>
        <p className="mt-0.5 text-sm text-ink">{trace.studentMessage}</p>
      </div>
      {trace.findings.map((f, i) => {
        const sev = SEVERITY[f.severity] || SEVERITY.info;
        const Icon = sev.icon;
        return (
          <div key={i} className={`rounded-xl border p-3 ${sev.className}`}>
            <div className="flex items-start gap-2">
              <Icon size={16} className="mt-0.5 shrink-0 text-ink-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-ink">{f.title}</p>
                  <Badge tone={sev.tone}>{AREA_LABELS[f.area] || f.area}</Badge>
                </div>
                <p className="mt-1 text-xs text-ink-muted">{f.detail}</p>
                {f.fix && (
                  <p className="mt-2 text-xs text-ink">
                    <span className="font-semibold">What to change: </span>
                    {f.fix}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RetrievalTab({ trace }) {
  const r = trace.retrieval;
  return (
    <div className="space-y-4">
      <div className="divide-y divide-border rounded-xl border border-border px-3">
        <Row label="Result">{MODE_LABELS[r.mode] || r.mode}{r.reason ? ` (${r.reason})` : ''}</Row>
        <Row label="Student wrote">{r.searchQueryOriginal}</Row>
        <Row label="Searched as">{r.translatedSearchQuery || r.searchQueryOriginal}</Row>
        {r.focusedQuery && <Row label="Focused query">{r.focusedQuery}</Row>}
        <Row label="KB used for message">{r.usedForMessage == null ? '—' : r.usedForMessage ? 'yes' : 'no'}</Row>
        <Row label="Search hits / top-K">{`${r.hitCount} / ${r.topK ?? '—'}`}</Row>
        <Row label="Min score">{r.minScore || 'not set'}</Row>
        <Row label="KB text sent to model">{`${r.contextChars} chars`}</Row>
      </div>

      <div>
        <p className="mb-2 text-sm font-semibold text-ink">Chunks sent to the model ({r.chunks.length})</p>
        {r.chunks.length ? (
          <ul className="space-y-2">{r.chunks.map((c, i) => <ChunkCard key={i} chunk={c} />)}</ul>
        ) : (
          <p className="text-xs text-ink-muted">No knowledge chunks were sent with this reply.</p>
        )}
      </div>

      {r.rejectedCandidates.length > 0 && (
        <div>
          <p className="mb-1 text-sm font-semibold text-ink">Closest matches that were rejected ({r.rejectedCandidates.length})</p>
          <p className="mb-2 text-xs text-ink-muted">Search found these but dropped them. If one is the right answer, add the student's phrasing to its variations.</p>
          <ul className="space-y-2">{r.rejectedCandidates.map((c, i) => <ChunkCard key={i} chunk={c} muted />)}</ul>
        </div>
      )}
    </div>
  );
}

function PromptTab({ trace }) {
  const p = trace.prompt;
  const [showMessages, setShowMessages] = useState(false);
  return (
    <div className="space-y-4">
      <div className="divide-y divide-border rounded-xl border border-border px-3">
        <Row label="Prompt">
          {p.source === 'draft' ? 'Unpublished draft' : `Published${p.version ? ` — version #${p.version.id}` : ''}`}
          {p.version?.createdAt ? ` (${p.version.createdAt})` : ''}
          {p.version?.note ? ` · ${p.version.note}` : ''}
        </Row>
        <Row label="User message to model">{p.llmUserMessage}</Row>
        <Row label="History messages">{trace.context ? trace.context.historyCount : '—'}</Row>
        {trace.context && (
          <Row label="Conversation mode">
            {trace.context.label || trace.context.mode}
            {trace.context.topic ? ` · topic: ${trace.context.topic}` : ''}
            {trace.context.switched ? ` · switched (${trace.context.reason})` : ''}
          </Row>
        )}
      </div>

      {p.systemPrompt ? (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-sm font-semibold text-ink">Full system prompt sent ({p.systemPrompt.length.toLocaleString()} chars)</p>
            <CopyButton value={p.systemPrompt} />
          </div>
          <p className="mb-2 text-xs text-ink-muted">Includes your prompt, the student profile, the retrieved KB block and output rules — exactly what the model saw.</p>
          <Pre className="max-h-[28rem] overflow-y-auto">{p.systemPrompt}</Pre>
        </div>
      ) : (
        <p className="text-xs text-ink-muted">The model was not called for this reply.</p>
      )}

      {p.messages.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowMessages((v) => !v)}
            className="inline-flex items-center gap-1 text-sm font-semibold text-ink"
          >
            <ChevronDown size={14} className={showMessages ? 'rotate-180' : ''} /> Message list sent ({p.messages.length})
          </button>
          {showMessages && (
            <ol className="mt-2 space-y-2">
              {p.messages.map((m, i) => (
                <li key={i} className="rounded-lg border border-border p-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">{m.role}</span>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-ink">
                    {m.role === 'system' ? '(system prompt above)' : m.content}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function ModelTab({ trace }) {
  const m = trace.model;
  if (!m) {
    return <p className="text-xs text-ink-muted">The model was not called for this reply{trace.shortCircuit ? ` (${trace.shortCircuit})` : ''}.</p>;
  }
  return (
    <div className="space-y-4">
      <div className="divide-y divide-border rounded-xl border border-border px-3">
        <Row label="Model">{`${m.model} (${m.tier} tier)`}</Row>
        <Row label="Temperature">
          {m.temperatureSent == null ? `not sent — model uses its default (requested ${m.temperatureRequested})` : m.temperatureSent}
        </Row>
        <Row label="Temperature rule">{m.temperatureRule}</Row>
        <Row label="Tokens">{`${m.promptTokens ?? '—'} in · ${m.completionTokens ?? '—'} out · ${m.totalTokens ?? '—'} total`}</Row>
        <Row label="Latency">{m.latencyMs != null ? `${(m.latencyMs / 1000).toFixed(2)} s` : '—'}</Row>
        <Row label="Finish reason">{m.finishReason}</Row>
        {trace.structured && (
          <Row label="Structured flags">
            {[
              trace.structured.eventType && `event: ${trace.structured.eventType}`,
              trace.structured.nudgeType && `nudge: ${trace.structured.nudgeType}`,
              trace.structured.conversationEnd && 'conversation end',
            ].filter(Boolean).join(' · ') || 'none'}
          </Row>
        )}
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">Raw model output</p>
          <CopyButton value={m.rawContent || ''} />
        </div>
        <p className="mb-2 text-xs text-ink-muted">Before JSON parsing and reply clean-up.</p>
        <Pre className="max-h-80 overflow-y-auto">{m.rawContent || '(empty)'}</Pre>
      </div>
    </div>
  );
}

const TABS = [
  { id: 'diagnosis', label: 'Diagnosis' },
  { id: 'retrieval', label: 'Knowledge' },
  { id: 'prompt', label: 'Prompt' },
  { id: 'model', label: 'Model' },
];

/** Drawer explaining how one playground reply was produced and what to fix. */
export default function ReplyInspector({ message, onClose }) {
  const [tab, setTab] = useState('diagnosis');
  useEffect(() => setTab('diagnosis'), [message]);
  const trace = message?.trace;
  const problems = trace?.findings.filter((f) => f.severity === 'error' || f.severity === 'warning').length || 0;

  return (
    <Drawer
      open={Boolean(trace)}
      onClose={onClose}
      width="max-w-3xl"
      title="Reply inspector"
      subtitle={
        trace && (
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={problems ? 'warning' : 'success'}>{problems ? `${problems} thing(s) to check` : 'No problems found'}</Badge>
            <span className="text-xs">{MODE_LABELS[trace.retrieval.mode] || trace.retrieval.mode || 'no KB'}</span>
          </span>
        )
      }
      footer={
        trace && (
          <CopyButton label="Copy full trace (JSON)" value={JSON.stringify({ reply: message.content, ...trace }, null, 2)} />
        )
      }
    >
      {trace && (
        <>
          <Tabs value={tab} onChange={setTab} tabs={TABS} className="mb-4" />
          {tab === 'diagnosis' && <DiagnosisTab trace={trace} />}
          {tab === 'retrieval' && <RetrievalTab trace={trace} />}
          {tab === 'prompt' && <PromptTab trace={trace} />}
          {tab === 'model' && <ModelTab trace={trace} />}
        </>
      )}
    </Drawer>
  );
}
