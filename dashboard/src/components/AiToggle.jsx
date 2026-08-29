import React, { useState } from 'react';
import { dataApi } from '../api/client';

export default function AiToggle({ chatId, active, onChange, compact = false }) {
  const [busy, setBusy] = useState(false);
  const isOn = Boolean(active);

  async function handleToggle(e) {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;

    const next = !isOn;
    setBusy(true);
    try {
      const data = await dataApi.setChatAssistant(chatId, next);
      onChange?.(data.chat);
    } catch {
      // keep previous state
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      aria-label={isOn ? 'Turn AI off' : 'Turn AI on'}
      className={`ai-switch${isOn ? ' ai-switch-on' : ''}${compact ? ' ai-switch-compact' : ''}`}
      onClick={handleToggle}
      disabled={busy}
      title={isOn ? 'AI replies on — tap to turn off' : 'AI replies off — tap to turn on'}
    >
      <span className="ai-switch-track" aria-hidden="true">
        <span className="ai-switch-thumb" />
      </span>
      {!compact && <span className="ai-switch-label">AI</span>}
    </button>
  );
}
