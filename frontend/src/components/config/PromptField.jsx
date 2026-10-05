import React from 'react';

export default function PromptField({
  label,
  guide,
  hint,
  value,
  onChange,
  rows = 4,
  onReset,
  defaultValue,
  placeholder = '',
}) {
  const changed = defaultValue != null && value !== defaultValue;

  return (
    <div className="field prompt-field">
      <div className="field-head">
        <label>{label}</label>
        {onReset && changed && (
          <button type="button" className="link-btn" onClick={() => onReset()}>
            Reset to default
          </button>
        )}
      </div>
      {guide && <p className="field-guide">{guide}</p>}
      {hint && <p className="field-hint">{hint}</p>}
      <textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
