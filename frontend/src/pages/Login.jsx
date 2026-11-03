import React, { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Button, Input, Card, Logo } from '../components/ds';

export default function Login() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  if (!loading && user) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Logo size={56} className="mx-auto" />
          <h1 className="mt-4 text-2xl font-semibold text-ink">Pulse</h1>
          <p className="mt-1 text-sm text-ink-muted">Your student support workspace</p>
        </div>

        <Card>
          <h2 className="text-lg font-semibold text-ink">Welcome to Pulse</h2>
          <p className="mb-6 mt-1 text-sm text-ink-muted">Sign in to follow up with students and manage your AI assistants.</p>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}
            <Input
              label="Email"
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              required
            />
            <Input
              label="Password"
              id="password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button type="button" aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)} className="min-h-10 text-sm font-medium text-primary hover:underline">{showPassword ? 'Hide password' : 'Show password'}</button>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign in to Pulse'}
            </Button>
            {loading && <p role="status" className="text-center text-xs text-ink-muted">Connecting to your workspace. The first connection may take longer.</p>}
          </form>
        </Card>
      </div>
    </div>
  );
}
