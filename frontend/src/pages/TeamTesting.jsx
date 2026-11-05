import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Alert, Button, Card, Input, SectionHeader, Spinner, Textarea } from '../components/ds';
import Playground from '../components/bot/Playground';
import AiLimitSettings from '../components/bot/AiLimitSettings';
import { readKnowledgeFile } from '../utils/kbFileText';

export default function TeamTesting() {
  const { team, scopeVersion } = useAuth();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const result = await api('/team-testing', { allNumbers: true });
    setData(result);
    setForm({ name: result.bot.name, prompt: result.prompt || '', assistantName: result.assistantName || '',
      contextWindowMinutes: result.contextWindowMinutes || 60, aiLimits: result.aiLimits || {},
      resourceIds: result.bot.knowledgeResourceIds, sharedUserIds: result.sharedUserIds || [] });
  }

  useEffect(() => {
    let active = true;
    setData(null); setError(''); setNotice('');
    api('/team-testing', { allNumbers: true }).then(result => {
      if (!active) return;
      setData(result);
      setForm({ name: result.bot.name, prompt: result.prompt || '', assistantName: result.assistantName || '',
        contextWindowMinutes: result.contextWindowMinutes || 60, aiLimits: result.aiLimits || {}, resourceIds: result.bot.knowledgeResourceIds,
        sharedUserIds: result.sharedUserIds || [] });
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [scopeVersion, team?.id]);

  const set = key => event => setForm(previous => ({ ...previous, [key]: event.target.value }));
  const toggle = (key, id) => setForm(previous => ({ ...previous,
    [key]: previous[key].includes(id) ? previous[key].filter(value => value !== id) : [...previous[key], id] }));

  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await api('/team-testing', { method: 'PUT', allNumbers: true, body: form });
      await load(); setNotice('Testing bot saved. New messages use these settings.');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function upload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const extracted = await readKnowledgeFile(file);
      await api('/team-testing/knowledge', { method: 'POST', allNumbers: true,
        body: { title: file.name, filename: file.name, kind: extracted.kind, content: extracted.text } });
      await load(); setNotice('Knowledge uploaded and linked.');
    } catch (err) { setError(err.message); } finally { setBusy(false); event.target.value = ''; }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <SectionHeader eyebrow={team?.name} title={data?.bot.name || 'Testing bot'} subtitle="Test prompts and knowledge without connecting a WhatsApp number. Conversations are private to each user." />
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {!data ? (!error && <Spinner />) : <>
        {data.canManage && <Card><form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Input label="Testing bot name" value={form.name} onChange={set('name')} required />
            <Input label="Assistant name" value={form.assistantName} onChange={set('assistantName')} />
            <Input label="Context window (minutes)" type="number" min="1" max="1440" value={form.contextWindowMinutes} onChange={set('contextWindowMinutes')} />
          </div>
          <Textarea label="System prompt" value={form.prompt} onChange={set('prompt')} rows={8} required />
          <label className="block text-sm font-medium">Upload prompt (.txt or .md)
            <input className="mt-2 block" type="file" accept=".txt,.md" disabled={busy} onChange={async event => {
              const file = event.target.files?.[0];
              if (file) { const prompt = await file.text(); setForm(previous => ({ ...previous, prompt })); }
              event.target.value = '';
            }} />
          </label>
          <fieldset className="space-y-2"><legend className="font-semibold">Knowledge base</legend>
            {data.resources.map(resource => <label key={resource.id} className="flex gap-2 text-sm">
              <input type="checkbox" checked={form.resourceIds.includes(resource.id)} onChange={() => toggle('resourceIds', resource.id)} />{resource.title}
            </label>)}
          </fieldset>
          <label className="block text-sm">Upload knowledge (save other changes first)
            <input className="mt-2 block" type="file" accept=".pdf,.txt,.md,.csv,.json" disabled={busy} onChange={upload} />
          </label>
          <fieldset className="space-y-2"><legend className="font-semibold">Share chat access with team users</legend>
            <p className="text-xs text-ink-muted">Selected users can test replies. Only admins can edit settings, prompts, knowledge or sharing.</p>
            {data.members.map(member => <label key={member.id} className="flex gap-2 text-sm">
              <input type="checkbox" checked={form.sharedUserIds.includes(member.id)} onChange={() => toggle('sharedUserIds', member.id)} />{member.name}
            </label>)}
          </fieldset>
          <AiLimitSettings value={form.aiLimits} onChange={aiLimits => setForm(previous => ({ ...previous, aiLimits }))} />
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save testing bot'}</Button>
        </form></Card>}
        <Playground key={`${team?.id}-${data.bot.id}`} bot={data.bot}
          sendMessage={body => api('/team-testing/playground', { method: 'POST', body, allNumbers: true, timeoutMs: 120000 })} />
      </>}
    </div>
  );
}
