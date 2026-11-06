import React, { useEffect, useState } from 'react';
import { usersApi } from '../../api/client';
import { Button, Input, Select, Textarea } from '../ds';

export default function ActionCategorySettings({ rules, onChange, teamId }) {
  const [members, setMembers] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let canceled = false;
    setMembers([]);
    setError('');
    usersApi.list().then(({ users }) => {
      if (!canceled) setMembers(users.filter(user => user.isActive && user.teamId === teamId));
    }).catch(() => {
      if (!canceled) setError('Could not load team members. Reload to choose an assignee.');
    });
    return () => { canceled = true; };
  }, [teamId]);

  const update = (index, patch) => onChange(rules.map((row, i) => i === index ? { ...row, ...patch } : row));

  return (
    <div className="mt-4 space-y-3">
      <p className="text-xs text-ink-muted">
        Add categories to route matching conversations to specific team members. When categories are set, they take priority over the general trigger prompt.
      </p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {rules.map((rule, index) => (
        <div className="space-y-2 rounded-lg border p-3" key={index}>
          <Input label="Category name" maxLength={50} value={rule.category}
            onChange={event => update(index, { category: event.target.value })} />
          <Textarea label="When to create a task" rows={2} maxLength={500} value={rule.trigger}
            placeholder="For example, the student requests an attendance correction."
            onChange={event => update(index, { trigger: event.target.value })} />
          <Select label="Assign to" value={rule.assigneeId ?? ''}
            onChange={event => update(index, { assigneeId: Number(event.target.value) || null })}>
            <option value="">Unassigned</option>
            {rule.assigneeId && !members.some(user => user.id === rule.assigneeId) && (
              <option value={rule.assigneeId}>Previous assignee</option>
            )}
            {members.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
          </Select>
          <Button type="button" variant="secondary" onClick={() => onChange(rules.filter((_, i) => i !== index))}>
            Remove category
          </Button>
        </div>
      ))}
      <Button type="button" variant="secondary" disabled={rules.length >= 20}
        onClick={() => onChange([...rules, { category: '', trigger: '', assigneeId: null }])}>
        Add category
      </Button>
    </div>
  );
}
