import React, { useState } from 'react';
import { dataApi } from '../api/client';
import { Button, Segmented } from './ui';

function parseNameList(text) {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function ContactsPanel({ onDone, onHint }) {
  const [bulkAiOn, setBulkAiOn] = useState(true);
  const [groupNames, setGroupNames] = useState('');
  const [groupBusy, setGroupBusy] = useState(false);
  const [bulkCsvBusy, setBulkCsvBusy] = useState(false);

  const [showHistory, setShowHistory] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [historyCsvBusy, setHistoryCsvBusy] = useState(false);
  const [contactForm, setContactForm] = useState({
    contactName: '',
    contactPhone: '',
    enableAi: true,
    messagesText: '',
  });

  async function handleBulkApply() {
    const contactNames = parseNameList(groupNames);
    if (!contactNames.length) {
      onHint?.('Enter at least one contact name.');
      return;
    }
    setGroupBusy(true);
    try {
      const data = await dataApi.setAssistantForGroup({ contactNames, active: bulkAiOn });
      onHint?.(`AI ${bulkAiOn ? 'enabled' : 'disabled'} for ${data.updatedCount} contact(s).`);
      onDone?.();
    } catch (err) {
      onHint?.(err.message);
    } finally {
      setGroupBusy(false);
    }
  }

  async function handleBulkCsv(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBulkCsvBusy(true);
    try {
      const data = await dataApi.setAssistantForGroupCsv(file, bulkAiOn);
      onHint?.(`AI updated for ${data.updatedCount} contact(s) from CSV.`);
      onDone?.();
    } catch (err) {
      onHint?.(err.message);
    } finally {
      e.target.value = '';
      setBulkCsvBusy(false);
    }
  }

  async function handleImportContact(e) {
    e.preventDefault();
    const lines = contactForm.messagesText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!contactForm.contactName.trim() && !contactForm.contactPhone.trim()) {
      onHint?.('Contact name or phone is required.');
      return;
    }
    if (showHistory && !lines.length) {
      onHint?.('Add message lines or collapse chat history to import contact only.');
      return;
    }

    setImportBusy(true);
    try {
      const messages = lines.map((line) => {
        const m = line.match(/^(user|owner|assistant)\s*:\s*(.+)$/i);
        if (m) return { role: m[1].toLowerCase(), content: m[2] };
        return { role: 'user', content: line };
      });

      const result = await dataApi.importContact({
        contactName: contactForm.contactName.trim(),
        contactPhone: contactForm.contactPhone.trim(),
        enableAi: contactForm.enableAi,
        messages: messages.length ? messages : [{ role: 'user', content: '(contact imported)' }],
      });

      onHint?.(
        messages.length
          ? `Imported ${result.messageCount} messages for ${result.chat.contactName}.`
          : `Contact ${result.chat.contactName} added.`
      );
      setContactForm((prev) => ({ ...prev, messagesText: '' }));
      onDone?.();
    } catch (err) {
      onHint?.(err.message);
    } finally {
      setImportBusy(false);
    }
  }

  async function handleHistoryCsv(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setHistoryCsvBusy(true);
    try {
      const result = await dataApi.importContactCsv(file);
      onHint?.(`Imported ${result.records} messages across ${result.contacts} contact(s).`);
      onDone?.();
    } catch (err) {
      onHint?.(err.message);
    } finally {
      e.target.value = '';
      setHistoryCsvBusy(false);
    }
  }

  return (
    <div className="wa-contacts-panel">
      <section className="wa-contact-card">
        <div className="wa-contact-card-head">
          <h2>Bulk AI for contacts</h2>
          <p>Turn AI on or off for many contacts by name. Matches partial names in your chat list.</p>
        </div>

        <div className="wa-contact-field">
          <label>AI replies</label>
          <Segmented
            value={bulkAiOn ? 'on' : 'off'}
            onChange={(v) => setBulkAiOn(v === 'on')}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' },
            ]}
          />
        </div>

        <div className="wa-contact-field">
          <label htmlFor="group-names">Contact names</label>
          <textarea
            id="group-names"
            rows={3}
            value={groupNames}
            onChange={(e) => setGroupNames(e.target.value)}
            placeholder={'Anil, Priya\nsales contacts'}
          />
          <p className="wa-contact-hint">Comma or newline separated. Partial name match works.</p>
        </div>

        <Button type="button" variant="primary" onClick={handleBulkApply} disabled={groupBusy}>
          {groupBusy ? 'Applying…' : `Apply — AI ${bulkAiOn ? 'on' : 'off'}`}
        </Button>

        <div className="wa-contact-divider">
          <span>or CSV</span>
        </div>

        <div className="wa-contact-field">
          <label>Upload contact list</label>
          <label className="wa-file-btn">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={handleBulkCsv}
              disabled={bulkCsvBusy}
            />
            {bulkCsvBusy ? 'Uploading…' : 'Choose CSV file'}
          </label>
          <p className="wa-contact-hint">
            Columns: <code>contact_name</code> (required), <code>active</code> optional (true/false).
            Rows without <code>active</code> use the toggle above.
          </p>
        </div>
      </section>

      <section className="wa-contact-card">
        <div className="wa-contact-card-head">
          <h2>Import contact</h2>
          <p>Add a contact to your chat list. Optionally paste past messages — not required.</p>
        </div>

        <form className="wa-contact-form" onSubmit={handleImportContact}>
          <div className="wa-contact-field">
            <label htmlFor="import-name">Name</label>
            <input
              id="import-name"
              value={contactForm.contactName}
              onChange={(e) => setContactForm((p) => ({ ...p, contactName: e.target.value }))}
              placeholder="Contact name"
            />
          </div>

          <div className="wa-contact-field">
            <label htmlFor="import-phone">Phone (optional)</label>
            <input
              id="import-phone"
              value={contactForm.contactPhone}
              onChange={(e) => setContactForm((p) => ({ ...p, contactPhone: e.target.value }))}
              placeholder="+91…"
            />
          </div>

          <div className="wa-contact-field wa-contact-toggle-row">
            <span>Enable AI for this contact</span>
            <button
              type="button"
              role="switch"
              aria-checked={contactForm.enableAi}
              className={`ai-switch ai-switch-compact${contactForm.enableAi ? ' ai-switch-on' : ''}`}
              onClick={() => setContactForm((p) => ({ ...p, enableAi: !p.enableAi }))}
            >
              <span className="ai-switch-track" aria-hidden="true">
                <span className="ai-switch-thumb" />
              </span>
            </button>
          </div>

          <button
            type="button"
            className="wa-contact-collapse"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
          >
            {showHistory ? '− Hide chat history' : '+ Add chat history (optional)'}
          </button>

          {showHistory && (
            <div className="wa-contact-field">
              <label htmlFor="import-msgs">Messages</label>
              <textarea
                id="import-msgs"
                rows={4}
                value={contactForm.messagesText}
                onChange={(e) => setContactForm((p) => ({ ...p, messagesText: e.target.value }))}
                placeholder={'user: hi\nassistant: hello\nowner: please call me'}
              />
            </div>
          )}

          <Button type="submit" variant="primary" disabled={importBusy}>
            {importBusy ? 'Importing…' : 'Import contact'}
          </Button>
        </form>
      </section>

      <section className="wa-contact-card">
        <div className="wa-contact-card-head">
          <h2>Import contacts + history (CSV)</h2>
          <p>Bulk import contacts with message history from a spreadsheet.</p>
        </div>

        <label className="wa-file-btn wa-file-btn-block">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={handleHistoryCsv}
            disabled={historyCsvBusy}
          />
          {historyCsvBusy ? 'Uploading…' : 'Upload history CSV'}
        </label>
        <p className="wa-contact-hint">
          Columns: <code>contact_name</code>, <code>contact_phone</code>, <code>role</code>,{' '}
          <code>content</code>, <code>timestamp</code>, <code>enable_ai</code> (optional per row).
        </p>
      </section>
    </div>
  );
}
