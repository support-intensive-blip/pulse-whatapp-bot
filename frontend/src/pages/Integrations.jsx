import React, { useEffect, useState } from 'react';
import { Plug } from 'lucide-react';
import { botsApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Alert, ButtonLink, Card, ConnectionBadge, EmptyState, SectionHeader, SoonTag, Spinner, formatPhone } from '../components/ds';
import { CopyField } from './BotWizard';
import { formatISTDateTime } from '../utils/time';

const CHECKLIST = [
  'Turn off Gallabox’s own bot / auto-reply on the number — otherwise two bots answer.',
  'Gallabox → Settings → Webhooks → Add webhook with the URL below, event Message.Received.',
  'Use the same webhook secret you saved for the number (signatures are verified).',
  'Free-form replies only work within 24 hours of the contact’s last message (WhatsApp rule).',
];

export default function Integrations() {
  const { team, scopeVersion } = useAuth();
  const [bots, setBots] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    botsApi.list().then((d) => setBots(d.bots)).catch((err) => setError(err.message));
  }, [scopeVersion, team?.id]);

  return (
    <div className="mx-auto max-w-5xl">
      <SectionHeader eyebrow={team?.name} title="Integrations" subtitle="Gallabox WhatsApp Business connections for this team." />
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}

      <Card className="mb-6">
        <p className="mb-2 text-sm font-semibold text-ink">Gallabox setup checklist</p>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-muted">
          {CHECKLIST.map((item) => <li key={item}>{item}</li>)}
        </ol>
      </Card>

      {!bots ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !bots.length ? (
        <EmptyState icon={Plug} title="No numbers connected" action={<ButtonLink to="/bots/new">Connect WhatsApp number</ButtonLink>} />
      ) : (
        <div className="space-y-4">
          {bots.map((bot) => (
            <Card key={bot.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-ink">{bot.name}</p>
                  <p className="text-sm text-ink-muted">{formatPhone(bot.whatsappPhone)} · channel <span className="font-mono text-xs">{bot.gallabox.channelId || '—'}</span></p>
                </div>
                <ConnectionBadge connected={bot.connection.connected} configured={bot.gallabox.configured} isActive={bot.isActive} />
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-[1fr_14rem]">
                <CopyField label="Webhook URL" value={bot.connection.webhookUrl} />
                <div className="text-sm">
                  <p className="text-ink-muted">Last webhook</p>
                  <p className="text-ink">{bot.lastInboundAt ? formatISTDateTime(bot.lastInboundAt) : 'Never'}</p>
                </div>
              </div>
              {bot.lastError && bot.isActive && <Alert tone="error" className="mt-3">{bot.lastError}</Alert>}
              <div className="mt-4 flex justify-end">
                <ButtonLink to={`/bots/${bot.id}?tab=integration`} variant="secondary" size="sm">Diagnostics &amp; credentials</ButtonLink>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-6 flex items-center justify-between">
        <span className="text-sm text-ink-muted">Webhook delivery history &amp; message-template sending</span>
        <SoonTag />
      </Card>
    </div>
  );
}
