import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, authApi } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [bot, setBot] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (options = {}) => {
    const { logoutOnUnauthorized = true } = options;
    const token = localStorage.getItem('dashboard_token');
    if (!token) {
      setUser(null);
      setBot(null);
      setLoading(false);
      return;
    }

    try {
      const data = await authApi.me();
      setUser(data.user);
      setBot(data.bot);
    } catch (err) {
      // Only clear session on actual auth failure — never on timeouts.
      // A slow API call must not kick the user out of the dashboard.
      const isUnauthorized = err instanceof ApiError && err.status === 401;
      if (isUnauthorized && logoutOnUnauthorized) {
        localStorage.removeItem('dashboard_token');
        setUser(null);
        setBot(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function login(email, password) {
    const data = await authApi.login(email, password);
    localStorage.setItem('dashboard_token', data.token);
    setUser(data.user);
    setBot(data.bot);
    return data;
  }

  function logout() {
    localStorage.removeItem('dashboard_token');
    setUser(null);
    setBot(null);
  }

  return (
    <AuthContext.Provider value={{ user, bot, setUser, setBot, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
