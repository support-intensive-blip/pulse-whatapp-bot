import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, BookOpen, MessageSquare, Plus, Settings2 } from 'lucide-react';
import { botsApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { AiStatusBadge, Alert, ButtonLink, Card, ConnectionBadge, EmptyState, SectionHeader, Spinner, formatPhone } from '../components/ds';
import { formatISTDateTime } from '../utils/time';

function BotCard({ bot }) {
  const { connection, gallabox } = bot;
  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
            <Bot size={20} strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-ink">{bot.name}</h3>
            <p className="text-xs text-ink-muted">{formatPhone(bot.whatsappPhone)}</p>
          </div>
        </div>
        <AiStatusBadge status={bot.aiStatus} />
      </div>

      {bot.description && <p className="mt-3 line-clamp-2 text-sm text-ink-muted">{bot.description}</p>}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
        <div>
          <dt className="text-ink-faint">Connection</dt>
          <dd className="mt-0.5">
            <ConnectionBadge connected={connection.connected} configured={gallabox.configured} isActive={bot.isActive} />
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">Channel ID</dt>
          <dd className="mt-0.5 truncate font-mono text-ink">{gallabox.channelId || '—'}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">Prompt</dt>
          <dd className="mt-0.5 text-ink">{bot.hasPrompt ? 'Published' : <span className="text-amber-700">Not written</span>}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">Knowledge</dt>
          <dd className="mt-0.5 flex items-center gap-1 text-ink">
            <BookOpen size={12} /> {bot.knowledgeResourceIds.length} resource{bot.knowledgeResourceIds.length === 1 ? '' : 's'}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">Conversations</dt>
          <dd className="mt-0.5 flex items-center gap-1 tabular-nums text-ink">
            <MessageSquare size={12} /> {bot.conversationCount.toLocaleString('en-IN')}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">Last activity</dt>
          <dd className="mt-0.5 text-ink">{bot.lastInboundAt ? formatISTDateTime(bot.lastInboundAt) : '—'}</dd>
        </div>
      </dl>

      {bot.lastError && bot.isActive && (
        <Alert tone="error" className="mt-3 text-xs">{bot.lastError}</Alert>
      )}

      <div className="mt-auto pt-4">
        <ButtonLink to={`/bots/${bot.id}`} variant="secondary" size="sm" className="w-full">
          <Settings2 size={14} /> Configure
        </ButtonLink>
      </div>
    </Card>
  );
}

export default function Bots() {
  const { team, scopeVersion } = useAuth();
  const [bots, setBots] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setBots(null);
    botsApi
      .list()
      .then((data) => setBots(data.bots))
      .catch((err) => setError(err.message));
  }, [scopeVersion, team?.id]);

  return (
    <div className="mx-auto max-w-7xl">
      <SectionHeader
        eyebrow={team?.name}
        title="AI Bots"
        subtitle="Every Gallabox WhatsApp number is an independent AI bot with its own credentials, prompt, knowledge and behavior."
        action={
          <ButtonLink to="/bots/new">
            <Plus size={16} /> Connect WhatsApp number
          </ButtonLink>
        }
      />
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}
      {!bots ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !bots.length ? (
        <EmptyState
          icon={Bot}
          title="No WhatsApp numbers yet"
          description="Connect your first Gallabox number. You'll add its API key, write the AI prompt and test it before going live."
          action={<ButtonLink to="/bots/new">Connect WhatsApp number</ButtonLink>}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {bots.map((bot) => (
            <BotCard key={bot.id} bot={bot} />
          ))}
        </div>
      )}
      <p className="mt-6 text-xs text-ink-muted">
        A number must have Gallabox's own bot / auto-reply turned off, otherwise two bots answer. See{' '}
        <Link to="/integrations" className="text-primary hover:underline">Integrations</Link> for webhook URLs.
      </p>
    </div>
  );
}
