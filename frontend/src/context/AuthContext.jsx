import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, authApi, setApiScope } from '../api/client';

const AuthContext = createContext(null);

const TEAM_KEY = 'pulse_team_id';
const BOT_KEY = 'pulse_bot_id';

function readStored(key) {
  try {
    const value = parseInt(localStorage.getItem(key), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    if (value) localStorage.setItem(key, String(value));
    else localStorage.removeItem(key);
  } catch {
    // storage unavailable — selection just isn't remembered
  }
}

/**
 * Session + workspace scope. `bots` are the WhatsApp numbers of the current team;
 * `currentBotId` null means "All Numbers". The owner can switch teams.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [team, setTeam] = useState(null);
  const [teams, setTeams] = useState([]);
  const [bots, setBots] = useState([]);
  const [permissions, setPermissions] = useState({ isOwner: false, isAdmin: false });
  const [currentBotId, setCurrentBotIdState] = useState(() => readStored(BOT_KEY));
  const [loading, setLoading] = useState(true);
  const [scopeVersion, setScopeVersion] = useState(0);

  const applyMe = useCallback((data) => {
    setUser(data.user);
    setTeam(data.team || null);
    setTeams(data.teams || []);
    setBots(data.bots || []);
    setPermissions(data.permissions || { isOwner: false, isAdmin: false });
    setApiScope({ teamId: data.team?.id || null });
    // Drop a remembered number that isn't in this team any more.
    setCurrentBotIdState((current) => {
      const valid = current && (data.bots || []).some((bot) => bot.id === current) ? current : null;
      setApiScope({ botId: valid });
      writeStored(BOT_KEY, valid);
      return valid;
    });
  }, []);

  const refresh = useCallback(async (options = {}) => {
    const { logoutOnUnauthorized = true } = options;
    const token = localStorage.getItem('dashboard_token');
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      setApiScope({ teamId: readStored(TEAM_KEY), botId: readStored(BOT_KEY) });
      applyMe(await authApi.me());
    } catch (err) {
      // Only clear the session on a real auth failure — never on timeouts.
      const isUnauthorized = err instanceof ApiError && (err.status === 401 || err.status === 403);
      if (isUnauthorized && logoutOnUnauthorized) {
        localStorage.removeItem('dashboard_token');
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, [applyMe]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function login(email, password) {
    const data = await authApi.login(email, password);
    localStorage.setItem('dashboard_token', data.token);
    await refresh();
    return data;
  }

  function logout() {
    localStorage.removeItem('dashboard_token');
    writeStored(BOT_KEY, null);
    setApiScope({ teamId: null, botId: null });
    setUser(null);
    setTeam(null);
    setBots([]);
  }

  /** Owner only: work on another team. */
  const switchTeam = useCallback(
    async (teamId) => {
      writeStored(TEAM_KEY, teamId);
      writeStored(BOT_KEY, null);
      setApiScope({ teamId, botId: null });
      setCurrentBotIdState(null);
      await refresh();
      setScopeVersion((v) => v + 1);
    },
    [refresh]
  );

  /** null = All Numbers. */
  const setCurrentBotId = useCallback((botId) => {
    const id = botId ? Number(botId) : null;
    writeStored(BOT_KEY, id);
    setApiScope({ botId: id });
    setCurrentBotIdState(id);
    setScopeVersion((v) => v + 1);
  }, []);

  const value = useMemo(
    () => ({
      user,
      setUser,
      team,
      teams,
      bots,
      permissions,
      isOwner: permissions.isOwner,
      isAdmin: permissions.isAdmin,
      currentBotId,
      currentBot: bots.find((bot) => bot.id === currentBotId) || null,
      setCurrentBotId,
      switchTeam,
      // Changes whenever team/number selection changes — pages reload on it.
      scopeVersion,
      loading,
      login,
      logout,
      refresh,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, team, teams, bots, permissions, currentBotId, scopeVersion, loading, refresh, switchTeam, setCurrentBotId]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
