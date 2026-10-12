import React, { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Conversations from './pages/Conversations';
import ActionItems from './pages/ActionItems';
import Contacts from './pages/Contacts';
import Analytics from './pages/Analytics';
import Bots from './pages/Bots';
import BotWizard from './pages/BotWizard';
import BotWorkspace from './pages/BotWorkspace';
import Knowledge from './pages/Knowledge';
import TeamUsers from './pages/TeamUsers';
import Integrations from './pages/Integrations';
import Teams from './pages/Teams';
import Account from './pages/Account';
import TokenUsage from './pages/TokenUsage';

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!loading) {
      setTimedOut(false);
      return undefined;
    }
    const timer = setTimeout(() => setTimedOut(true), 8000);
    return () => clearTimeout(timer);
  }, [loading]);

  if (loading && !timedOut) {
    return <div className="page-loading">Loading...</div>;
  }

  if (!user) return <Navigate to="/login" replace />;
  return children;
}

/** Hides admin/owner screens from roles that can't use them (the API enforces it too). */
function RoleRoute({ level, children }) {
  const { isAdmin, isOwner } = useAuth();
  const allowed = level === 'owner' ? isOwner : isAdmin;
  return allowed ? children : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <Layout />
          </PrivateRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="conversations" element={<Conversations />} />
        <Route path="conversations/:id" element={<Conversations />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="actions" element={<ActionItems />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="bots" element={<RoleRoute level="admin"><Bots /></RoleRoute>} />
        <Route path="bots/new" element={<RoleRoute level="admin"><BotWizard /></RoleRoute>} />
        <Route path="bots/:botId" element={<RoleRoute level="admin"><BotWorkspace /></RoleRoute>} />
        <Route path="knowledge" element={<RoleRoute level="admin"><Knowledge /></RoleRoute>} />
        <Route path="usage" element={<RoleRoute level="admin"><TokenUsage /></RoleRoute>} />
        <Route path="team" element={<RoleRoute level="admin"><TeamUsers /></RoleRoute>} />
        <Route path="integrations" element={<RoleRoute level="admin"><Integrations /></RoleRoute>} />
        <Route path="teams" element={<RoleRoute level="owner"><Teams /></RoleRoute>} />
        <Route path="settings" element={<Account />} />
        {/* Old links */}
        <Route path="account" element={<Navigate to="/settings" replace />} />
        <Route path="connect" element={<Navigate to="/integrations" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
