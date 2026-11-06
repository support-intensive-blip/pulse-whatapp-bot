import React from 'react';
import { Button, Input, Textarea, Toggle } from '../ds';
import { OptionHelp } from './AiLimitSettings';

export default function WhatsAppMenuSettings({ value, onChange }) {
  const options = value.options || [];
  const update = (changes) => onChange({ ...value, ...changes });
  const updateOption = (id, changes) => update({
    options: options.map(option => option.id === id ? { ...option, ...changes } : option),
  });
  const moveUp = (index) => {
    const next = [...options];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    update({ options: next });
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-ink">WhatsApp menu</h3>
      <Toggle checked={Boolean(value.enabled)} onChange={enabled => update({ enabled })}
        label="Enable WhatsApp menu" />
      {value.enabled && (
        <>
          <p className="text-xs text-ink-muted">
            Gupshup shows a tappable list. Other connections show the same options as text, so users can type an option.
          </p>
          <Toggle checked={Boolean(value.greetings)} onChange={greetings => update({ greetings })}
            label="Show for simple greetings" />
          <Textarea label="Menu shortcuts" rows={2} value={(value.shortcuts || []).join('\n')}
            hint="One per line. A message must match the full shortcut, such as menu or help."
            onChange={event => update({ shortcuts: event.target.value.split('\n') })} />
          <Textarea label="Menu introduction" rows={2} maxLength={500} value={value.intro || ''}
            onChange={event => update({ intro: event.target.value })} />
          <Input label="Menu title" maxLength={60} value={value.title || ''}
            onChange={event => update({ title: event.target.value })} />
          <Input label="Menu button label" maxLength={20} value={value.button || ''}
            onChange={event => update({ button: event.target.value })} />
          <div className="flex items-center gap-2 text-sm font-medium">
            Menu options
            <OptionHelp label="Menu options">
              Add up to 10 options. When someone selects an option, Pulse answers its configured request using the bot’s prompt and knowledge.
            </OptionHelp>
          </div>
          {options.map((option, index) => (
            <div key={option.id} className="space-y-2 rounded-lg border p-3">
              <Input label={`Option ${index + 1} label`} maxLength={24} value={option.label}
                onChange={event => updateOption(option.id, { label: event.target.value })} />
              <Input label="Option description (optional)" maxLength={72} value={option.description || ''}
                onChange={event => updateOption(option.id, { description: event.target.value })} />
              <Textarea label="What the bot should answer" rows={2} maxLength={500} value={option.request}
                hint="Optional. For example, explain how to check attendance. If blank, Pulse uses the option label."
                onChange={event => updateOption(option.id, { request: event.target.value })} />
              <div className="flex gap-2">
                <Button type="button" variant="secondary" disabled={index === 0} onClick={() => moveUp(index)}>Move up</Button>
                <Button type="button" variant="secondary"
                  onClick={() => update({ options: options.filter(row => row.id !== option.id) })}>Remove</Button>
              </div>
            </div>
          ))}
          <Button type="button" variant="secondary" disabled={options.length >= 10}
            onClick={() => update({ options: [...options, { id: crypto.randomUUID(), label: '', request: '' }] })}>
            Add option
          </Button>
        </>
      )}
    </div>
  );
}
