import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SectionHeader, Badge, Button, Card, EmptyState, ActionItemSkeleton } from '../components/ds';
import { Segmented } from '../components/ui';
import { formatActionItemTime, actionItemChatUrl } from '../utils/actionLinks';
import { useActionItemsFeed } from '../hooks/useActionItemsFeed';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'done', label: 'Done' },
];

export default function ActionItems() {
  const [filter, setFilter] = useState('');
  const [coachFilter, setCoachFilter] = useState('');
  const [studentFilter, setStudentFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [markingDoneId, setMarkingDoneId] = useState(null);

  const isAdmin = false;

  const queryParams = useMemo(
    () => ({
      status: filter || undefined,
      coach: isAdmin ? coachFilter : undefined,
      student: studentFilter || undefined,
      category: categoryFilter || undefined,
    }),
    [filter, coachFilter, studentFilter, categoryFilter, isAdmin]
  );

  const { items, counts, loading, refreshing, markDone } = useActionItemsFeed(queryParams);

  const categories = useMemo(() => {
    const vals = new Set(items.map((item) => item.category).filter(Boolean));
    return ['', ...[...vals].sort()];
  }, [items]);

  const coachOptions = useMemo(
    () =>
      [...new Set(items.map((item) => item.assigned_user_name).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [items]
  );
  const studentOptions = useMemo(
    () =>
      [...new Set(items.map((item) => item.contact_name).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [items]
  );

  async function handleMarkDone(id) {
    setMarkingDoneId(id);
    try {
      await markDone(id);
    } finally {
      setMarkingDoneId(null);
    }
  }

  const pendingCount = counts.pending;
  const doneCount = counts.done;
  const totalCount = counts.total;

  return (
    <div className="mx-auto max-w-7xl">
      <SectionHeader
        title="Call to Action"
        subtitle="Coach queue for escalations — each item links to the exact WhatsApp message."
        action={<Segmented value={filter} onChange={setFilter} options={FILTERS} />}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card className="!p-4 border-l-4 border-l-warning">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Pending</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-ink">{pendingCount}</p>
        </Card>
        <Card className="!p-4 border-l-4 border-l-success">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Completed</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-ink">{doneCount}</p>
        </Card>
        <Card className="!p-4 border-l-4 border-l-primary">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Total</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-ink">{totalCount}</p>
        </Card>
      </div>

      <Card className="mb-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {isAdmin && (
            <div className="field">
              <label>Assigned user</label>
              <input
                list="user-filter-options"
                placeholder="Search by user name"
                value={coachFilter}
                onChange={(e) => setCoachFilter(e.target.value)}
              />
              <datalist id="user-filter-options">
                {coachOptions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
          )}
          <div className="field">
            <label>Contact</label>
            <input
              list="contact-filter-options"
              placeholder="Search by contact name"
              value={studentFilter}
              onChange={(e) => setStudentFilter(e.target.value)}
            />
            <datalist id="contact-filter-options">
              {studentOptions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label>Category</label>
            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              {categories.map((cat) => (
                <option key={cat || 'all'} value={cat}>
                  {cat || 'All'}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {loading ? (
        <Card className="overflow-hidden !p-0">
          <ActionItemSkeleton rows={5} />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState title="All clear" description="Triggered actions will show up here." />
        </Card>
      ) : (
        <Card
          className={`overflow-hidden !p-0 transition-opacity duration-200 ${refreshing ? 'opacity-90' : ''}`}
        >
          {refreshing && (
            <div className="border-b border-border bg-primary-soft/50 px-5 py-2 text-xs font-medium text-primary">
              Refreshing queue…
            </div>
          )}
          {items.map((item) => (
            <article
              key={item.id}
              className="border-b border-border p-5 transition-colors duration-150 last:border-0 hover:bg-slate-50/50"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap gap-2">
                    <Badge tone="neutral">{item.source}</Badge>
                    {item.priority === 'l2' && <Badge tone="warning">L2</Badge>}
                    {item.category && <Badge tone="neutral">{item.category}</Badge>}
                    <Badge tone={item.status === 'pending' ? 'warning' : 'success'}>
                      {item.status}
                    </Badge>
                  </div>
                  <h3 className="text-base font-semibold text-ink">{item.title}</h3>
                  {item.description && (
                    <p className="mt-1 text-sm text-ink-muted">{item.description}</p>
                  )}
                  <p className="mt-2 text-xs text-ink-muted">
                    {item.contact_name || 'Unknown contact'}
                    {item.assigned_user_name ? ` · ${item.assigned_user_name}` : ''}
                    {formatActionItemTime(item) ? ` · ${formatActionItemTime(item)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {item.chat_profile_id && (
                    <Link
                      to={actionItemChatUrl(item)}
                      className="inline-flex h-8 items-center rounded-lg border border-border bg-white px-3 text-xs font-medium text-ink hover:bg-slate-50"
                    >
                      Open chat
                    </Link>
                  )}
                  {item.status === 'pending' && (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={markingDoneId === item.id}
                      onClick={() => handleMarkDone(item.id)}
                    >
                      {markingDoneId === item.id ? 'Saving…' : 'Mark done'}
                    </Button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </Card>
      )}
    </div>
  );
}
