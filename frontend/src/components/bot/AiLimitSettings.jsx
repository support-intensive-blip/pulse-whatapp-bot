import React, { useId, useState } from 'react';
import { Info } from 'lucide-react';
import { Input } from '../ds';

export function OptionHelp({ label, children }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="inline-flex rounded p-1 text-ink-muted hover:text-primary"
      aria-label={`Help: ${label}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <Info size={15} aria-hidden="true" />
    </button>
    <span id={id} className={open ? 'block rounded-lg bg-slate-50 p-2 text-xs font-normal text-ink-muted' : 'hidden'}>{children}</span>
  </>;
}

export function LimitField({ label, value, onChange, max, help }) {
  const id = useId();
  return <div>
    <div className="flex items-center gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink">{label}</label>
      <OptionHelp label={label}>{help}</OptionHelp>
    </div>
    <Input id={id} type="number" min={0} max={max} step={1} placeholder="0" value={value || ''}
      onChange={event => onChange(Number(event.target.value))} />
  </div>;
}

const tasks = [
  ['chat', 'Student replies', 'Caps replies whether or not the answer uses knowledge. Allow room for the structured response as well as the visible text.'],
  ['kb', 'Knowledge processing', 'Caps knowledge lookup support tasks such as rewriting or translating search queries.'],
  ['context', 'Context processing', 'Caps outputs used to prepare conversation context.'],
  ['summary', 'Summaries', 'Caps conversation summary output.'],
  ['pdf', 'PDF analysis', 'Caps the AI response when analyzing a document.'],
  ['profile', 'Profile extraction', 'Caps output used to extract contact details or preferences.'],
  ['firewall', 'Scope checks', 'Caps the classifier output when an AI scope check is enabled.'],
  ['action_trigger', 'Call-to-Action checks', 'Caps output for deciding whether a message matches this bot’s action rules. Leave enough space for its structured result.'],
  ['other', 'Other text tasks', 'Caps other AI text completions attributed to this bot.'],
];

export default function AiLimitSettings({ value = {}, onChange }) {
  const set = key => next => onChange({ ...value, [key]: next });
  return <div className="space-y-4">
    <div>
      <h3 className="text-sm font-semibold text-ink">AI limits</h3>
      <p className="text-xs text-ink-muted">Use 0 or leave blank for no custom limit. Limits apply to live and test text requests.</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      <LimitField label="Input characters" max={100000} value={value.inputChars} onChange={set('inputChars')}
        help="Rejects oversized messages before the reply model is called. Ask the student to send the error and relevant function instead of a large code dump." />
      <LimitField label="Context tokens (estimate)" max={1000000} value={value.contextTokens} onChange={set('contextTokens')}
        help="Limits the estimated size of the full text request, including prompt, knowledge, and history. Pulse drops older history first. If the prompt and current message still do not fit, it skips the call." />
      <LimitField label="Daily bot tokens" max={100000000} value={value.dailyTokens} onChange={set('dailyTokens')}
        help="Shared across this bot’s live and testing text calls. Includes input and output. Resets at midnight IST. A team budget can stop a call sooner." />
    </div>
    <details className="rounded-xl border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Output tokens by task</summary>
      <p className="mt-2 text-xs text-ink-muted">These are model output limits, which may include reasoning tokens. Very low values can cut replies short.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {tasks.map(([task, label, help]) => <LimitField key={task} label={label} max={32768}
          value={value.outputTokens?.[task]} help={help}
          onChange={next => onChange({ ...value, outputTokens: { ...value.outputTokens, [task]: next } })} />)}
      </div>
    </details>
  </div>;
}
