import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightLeft, Bot, BookOpen, MessageSquare, Plus, Settings2 } from 'lucide-react';
import { botsApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  AiStatusBadge,
  Alert,
  Button,
  ButtonLink,
  Card,
  ConnectionBadge,
  EmptyState,
  Modal,
  SectionHeader,
  Select,
  Spinner,
  formatPhone,
} from '../components/ds';
import { formatISTDateTime } from '../utils/time';

/** Owner only: move a number (with its chats, CTAs and knowledge) to another team. */
function MoveBotModal({ bot, teams, currentTeam, onClose, onMoved }) {
  const targets = teams.filter((t) => t.id !== currentTeam?.id);
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setTeamId(targets[0]?.id ? String(targets[0].id) : '');
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot?.id]);

  async function move() {
    setBusy(true);
    setError('');
    try {
      onMoved(await botsApi.move(bot.id, Number(teamId)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const target = targets.find((t) => String(t.id) === teamId);
  return (
    <Modal
      open={Boolean(bot)}
      onClose={busy ? undefined : onClose}
      size="sm"
      title="Move to another team"
      subtitle={bot ? `${bot.name} · ${formatPhone(bot.whatsappPhone)}` : ''}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="md" onClick={move} disabled={busy || !teamId}>
            {busy ? 'Moving…' : 'Move number'}
          </Button>
        </>
      }
    >
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}
      {notice && <Alert tone="success" className="mb-4" onDismiss={() => setNotice('')}>{notice}</Alert>}
      {!targets.length ? (
        <p className="text-sm text-ink-muted">Create another team first under Teams.</p>
      ) : (
        <div className="space-y-4 text-sm">
          <Select label="Destination team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.isActive === false ? ' (inactive)' : ''}
              </option>
            ))}
          </Select>
          <ul className="list-disc space-y-1.5 pl-5 text-ink-muted">
            <li>Its conversations, contacts and Call-to-Actions move with it.</li>
            <li>Its linked knowledge is copied into {target?.name || 'the new team'} ({currentTeam?.name || 'this team'} keeps its copy).</li>
            <li>Chats and CTAs assigned to {currentTeam?.name || 'this team'}'s users become unassigned.</li>
            {target?.isActive === false && <li className="text-amber-700">The destination team is inactive, so the bot will stop replying.</li>}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function BotCard({ bot, onMove }) {
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

      <div className="mt-auto flex gap-2 pt-4">
        <ButtonLink to={`/bots/${bot.id}`} variant="secondary" size="sm" className="flex-1">
          <Settings2 size={14} /> Configure
        </ButtonLink>
        {onMove && (
          <Button variant="secondary" size="sm" onClick={() => onMove(bot)} title="Move to another team">
            <ArrowRightLeft size={14} /> Move
          </Button>
        )}
      </div>
    </Card>
  );
}

export default function Bots() {
  const { team, teams, isOwner, refresh, scopeVersion } = useAuth();
  const [bots, setBots] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [moving, setMoving] = useState(null);

  function load() {
    setBots(null);
    botsApi
      .list()
      .then((data) => setBots(data.bots))
      .catch((err) => setError(err.message));
  }

  useEffect(load, [scopeVersion, team?.id]);

  function handleMoved(result) {
    setMoving(null);
    const extras = [
      result.copiedResources ? `${result.copiedResources} knowledge resource(s) copied` : '',
      result.clearedChatAssignments + result.clearedCtaAssignments
        ? `${result.clearedChatAssignments + result.clearedCtaAssignments} assignment(s) cleared`
        : '',
    ].filter(Boolean);
    setNotice(`${result.bot.name} moved to ${result.toTeam.name}${extras.length ? ` · ${extras.join(' · ')}` : ''}.`);
    refresh();
    load();
  }

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
            <BotCard key={bot.id} bot={bot} onMove={isOwner && teams.length > 1 ? setMoving : null} />
          ))}
        </div>
      )}
      {isOwner && (
        <MoveBotModal bot={moving} teams={teams} currentTeam={team} onClose={() => setMoving(null)} onMoved={handleMoved} />
      )}
      <p className="mt-6 text-xs text-ink-muted">
        A number must have Gallabox's own bot / auto-reply turned off, otherwise two bots answer. See{' '}
        <Link to="/integrations" className="text-primary hover:underline">Integrations</Link> for webhook URLs.
      </p>
    </div>
  );
}
