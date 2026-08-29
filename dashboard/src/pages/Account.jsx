import React, { useState } from 'react';
import { authApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { SectionHeader, Button, Card, Input } from '../components/ds';

function memberInitials(name) {
  return (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export default function Account() {
  const { user, setUser } = useAuth();

  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function handlePasswordChange(e) {
    e.preventDefault();
    setError('');
    setMessage('');

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setError('New passwords do not match');
      return;
    }

    setPasswordBusy(true);
    try {
      const data = await authApi.changePassword(
        passwordForm.currentPassword,
        passwordForm.newPassword
      );
      setUser?.(data.user);
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setMessage('Password updated successfully.');
    } catch (err) {
      setError(err.message);
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <SectionHeader title="Profile" subtitle="Manage your password." />

      {(message || error) && (
        <div
          className={`mb-6 rounded-xl border px-4 py-3 text-sm ${
            error
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800'
          }`}
        >
          {error || message}
        </div>
      )}

      <div className="space-y-6">
        <Card className="p-5 sm:p-6">
          <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Profile
          </p>
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary">
              {memberInitials(user?.name)}
            </div>
            <div>
              <p className="text-lg font-semibold text-ink">{user?.name}</p>
              <p className="text-sm text-ink-muted">{user?.email}</p>
            </div>
          </div>
        </Card>

        <Card className="p-5 sm:p-6">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Change password
          </p>
          <p className="mb-4 text-sm text-ink-muted">
            Enter your current password, then choose a new one (min 6 characters).
          </p>
          <form className="space-y-4" onSubmit={handlePasswordChange}>
            <Input
              label="Current password"
              type="password"
              value={passwordForm.currentPassword}
              onChange={(e) =>
                setPasswordForm((p) => ({ ...p, currentPassword: e.target.value }))
              }
              autoComplete="current-password"
              required
            />
            <Input
              label="New password"
              type="password"
              value={passwordForm.newPassword}
              onChange={(e) => setPasswordForm((p) => ({ ...p, newPassword: e.target.value }))}
              autoComplete="new-password"
              minLength={6}
              required
            />
            <Input
              label="Confirm new password"
              type="password"
              value={passwordForm.confirmPassword}
              onChange={(e) =>
                setPasswordForm((p) => ({ ...p, confirmPassword: e.target.value }))
              }
              autoComplete="new-password"
              minLength={6}
              required
            />
            <Button type="submit" variant="primary" disabled={passwordBusy}>
              {passwordBusy ? 'Saving…' : 'Update password'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
