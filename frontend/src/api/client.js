import { readKnowledgeFile } from '../utils/kbFileText';

const API_BASE = '/api';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Team + number the dashboard is working on. Set by AuthContext; sent on every
// request so the backend scopes data (owner: x-team-id picks the team;
// x-bot-id narrows to one WhatsApp number, absent = "All Numbers").
const scope = { teamId: null, botId: null };

export function setApiScope({ teamId, botId } = {}) {
  if (teamId !== undefined) scope.teamId = teamId;
  if (botId !== undefined) scope.botId = botId;
}

function getToken() {
  return localStorage.getItem('dashboard_token');
}

function scopeHeaders({ allNumbers = false } = {}) {
  const headers = {};
  if (scope.teamId) headers['x-team-id'] = String(scope.teamId);
  if (scope.botId && !allNumbers) headers['x-bot-id'] = String(scope.botId);
  return headers;
}

export async function api(path, options = {}) {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...scopeHeaders({ allNumbers: options.allNumbers }),
    ...(options.headers || {}),
  };

  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const timeoutMs = options.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: options.method,
      headers,
      signal: controller.signal,
      body: options.body ? (isFormData ? options.body : JSON.stringify(options.body)) : undefined,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ApiError('Request timed out. Wait a moment and try again — you are still signed in.', 408);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function download(path, filename) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { ...scopeHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error || 'Download failed', res.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const authApi = {
  login: (email, password) => api('/auth/login', { method: 'POST', body: { email, password } }),
  me: () => api('/auth/me', { allNumbers: true }),
  changePassword: (currentPassword, newPassword) =>
    api('/auth/password', { method: 'PATCH', body: { currentPassword, newPassword } }),
};

export const configApi = {
  vapidPublicKey: () => api('/notifications/vapid-public-key'),
  subscribePush: (subscription) =>
    api('/notifications/subscribe', { method: 'POST', body: { subscription } }),
  unsubscribePush: (endpoint) =>
    api('/notifications/unsubscribe', { method: 'POST', body: { endpoint } }),
};

export const dataApi = {
  stats: (fresh = false) => api(`/stats${fresh ? `?fresh=${Date.now()}` : ''}`),
  conversations: (search = '', assistant = 'all', extra = {}) =>
    api(`/conversations${qs({ search, assistant, ...extra })}`, { timeoutMs: 45000 }),
  setChatAssistant: (chatId, active) =>
    api(`/conversations/${chatId}/assistant`, { method: 'PATCH', body: { active } }),
  updateContact: (chatId, body) => api(`/conversations/${chatId}/contact`, { method: 'PATCH', body }),
  contactChats: (contactKey, search = '') =>
    api(`/conversations/contact/${encodeURIComponent(contactKey)}/chats${qs({ search })}`),
  syncConversations: (search = '') => api(`/conversations/sync${qs({ search })}`, { method: 'POST' }),
  messages: (chatId, { limit = 200, since = null } = {}) =>
    api(`/conversations/${chatId}/messages${qs({ limit, since })}`),
  sendMessage: (chatId, content) =>
    api(`/conversations/${chatId}/messages`, { method: 'POST', body: { content }, timeoutMs: 45000 }),
  summarizeChat: (chatId) => api(`/conversations/${chatId}/summarize`, { method: 'POST', timeoutMs: 90000 }),
  sendSummaryToWhatsApp: (chatId) =>
    api(`/conversations/${chatId}/summarize-to-whatsapp`, { method: 'POST', timeoutMs: 120000 }),
  escalateChat: (chatId, body = {}) =>
    api(`/conversations/${chatId}/escalate`, { method: 'POST', body, timeoutMs: 30000 }),
  exportChats: (ids, format = 'json', filename, range = {}) => {
    const base =
      filename ||
      (ids?.length === 1 ? `chat-${ids[0]}` : ids?.length ? 'chats-selected' : 'chats-all');
    return download(
      `/conversations/export${qs({ format, ids: ids?.length ? ids.join(',') : null, from: range?.from, to: range?.to })}`,
      `${base}.${format}`
    );
  },
  actionItems: (params = {}) => api(`/action-items${qs(params)}`),
  updateActionItem: (id, statusOrPatch) =>
    api(`/action-items/${id}`, {
      method: 'PATCH',
      body: typeof statusOrPatch === 'string' ? { status: statusOrPatch } : statusOrPatch,
    }),
  importContact: (body) => api('/conversations/import', { method: 'POST', body }),
  importContactCsv: (file, botId) => {
    const fd = new FormData();
    fd.append('file', file);
    if (botId) fd.append('botId', String(botId));
    return api('/conversations/import-csv', { method: 'POST', body: fd });
  },
  setAssistantForGroup: ({ contactNames, active }) =>
    api('/conversations/assistant/bulk', { method: 'PATCH', body: { contactNames, active } }),
  bulkAssistantAll: (active) =>
    api('/conversations/assistant/bulk-all', { method: 'PATCH', body: { active } }),
  setAssistantForGroupCsv: (file, defaultActive = true) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('defaultActive', defaultActive ? 'true' : 'false');
    return api('/conversations/assistant/bulk-csv', { method: 'POST', body: fd });
  },
};

export const actionsApi = {
  list: (params = {}) => api(`/action-items${qs(params)}`),
  get: (id) => api(`/action-items/${id}`, { allNumbers: true }),
  create: (body) => api('/action-items', { method: 'POST', body }),
  update: (id, body) => api(`/action-items/${id}`, { method: 'PATCH', body, allNumbers: true }),
};

export const teamsApi = {
  overview: () => api('/owner/overview', { allNumbers: true }),
  list: () => api('/teams', { allNumbers: true }),
  create: (body) => api('/teams', { method: 'POST', body, allNumbers: true }),
  update: (id, body) => api(`/teams/${id}`, { method: 'PATCH', body, allNumbers: true }),
  auditLog: (teamId) => api(`/audit-log${qs({ teamId })}`, { allNumbers: true }),
};

// Admins see their team; the owner sees every team (teamId 'all') or one.
export const usageApi = {
  tokens: ({ days, teamId, env } = {}) => api(`/usage/tokens${qs({ days, teamId, env })}`, { allNumbers: true }),
};

export const usersApi = {
  members: () => api('/team/members', { allNumbers: true }),
  list: () => api('/users', { allNumbers: true }),
  create: (body) => api('/users', { method: 'POST', body, allNumbers: true }),
  update: (id, body) => api(`/users/${id}`, { method: 'PATCH', body, allNumbers: true }),
  resetPassword: (id, password) =>
    api(`/users/${id}/reset-password`, { method: 'POST', body: { password }, allNumbers: true }),
};

// Bot management always works on the whole team, whatever number is selected.
const botOpts = (extra = {}) => ({ allNumbers: true, ...extra });
export const botsApi = {
  list: () => api('/bots', botOpts()),
  get: (id) => api(`/bots/${id}`, botOpts()),
  create: (body) => api('/bots', botOpts({ method: 'POST', body, timeoutMs: 30000 })),
  update: (id, body) => api(`/bots/${id}`, botOpts({ method: 'PATCH', body, timeoutMs: 30000 })),
  updateCredentials: (id, body) => api(`/bots/${id}/credentials`, botOpts({ method: 'PUT', body, timeoutMs: 30000 })),
  testConnection: (body) => api('/bots/test-connection', botOpts({ method: 'POST', body, timeoutMs: 20000 })),
  testSaved: (id) => api(`/bots/${id}/test-connection`, botOpts({ method: 'POST', timeoutMs: 20000 })),
  // Owner only: move the number to another team.
  move: (id, teamId) => api(`/bots/${id}/move`, botOpts({ method: 'POST', body: { teamId }, timeoutMs: 30000 })),
  restart: (id) => api(`/bots/${id}/restart`, botOpts({ method: 'POST', timeoutMs: 30000 })),
  prompt: (id) => api(`/bots/${id}/prompt`, botOpts()),
  publishPrompt: (id, content, note) => api(`/bots/${id}/prompt`, botOpts({ method: 'PUT', body: { content, note } })),
  promptVersion: (id, versionId) => api(`/bots/${id}/prompt/versions/${versionId}`, botOpts()),
  restorePrompt: (id, versionId) =>
    api(`/bots/${id}/prompt/versions/${versionId}/restore`, botOpts({ method: 'POST' })),
  setKnowledge: (id, resourceIds) => api(`/bots/${id}/knowledge`, botOpts({ method: 'PUT', body: { resourceIds } })),
  knowledgeStatus: (id) => api(`/bots/${id}/knowledge/status`, botOpts()),
  reindex: (id) => api(`/bots/${id}/knowledge/reindex`, botOpts({ method: 'POST' })),
  playgroundHistory: (id, sessionId) => api(`/bots/${id}/playground${qs({ sessionId })}`, botOpts()),
  playground: (id, body) => api(`/bots/${id}/playground`, botOpts({ method: 'POST', body, timeoutMs: 90000 })),
  activity: (id) => api(`/bots/${id}/activity`, botOpts()),
};

export const knowledgeApi = {
  list: () => api('/knowledge', { allNumbers: true }),
  get: (id) => api(`/knowledge/${id}`, { allNumbers: true }),
  createText: (body) => api('/knowledge', { method: 'POST', body, allNumbers: true }),
  // Files are read in the browser (see utils/kbFileText) and sent as text: uploading
  // and parsing a large PDF server-side outlasts the API proxy timeout (504).
  upload: async (file, { title, botIds, onProgress } = {}) => {
    const { kind, text } = await readKnowledgeFile(file, onProgress);
    return api('/knowledge', {
      method: 'POST',
      body: { title: title || file.name.replace(/\.[^.]+$/, ''), content: text, kind, filename: file.name, botIds },
      allNumbers: true,
      timeoutMs: 60000,
    });
  },
  replaceFile: async (id, file, { onProgress } = {}) => {
    const { kind, text } = await readKnowledgeFile(file, onProgress);
    return api(`/knowledge/${id}/file`, {
      method: 'PUT',
      body: { content: text, kind, filename: file.name },
      allNumbers: true,
      timeoutMs: 60000,
    });
  },
  update: (id, body) => api(`/knowledge/${id}`, { method: 'PATCH', body, allNumbers: true }),
  remove: (id) => api(`/knowledge/${id}`, { method: 'DELETE', allNumbers: true }),
};

export const contactsApi = {
  list: (params = {}) => api(`/contacts${qs(params)}`, { timeoutMs: 45000 }),
  downloadTemplate: () => download('/contacts/import/template', 'pulse-contacts-template.csv'),
  exportCsv: (params = {}) => download(`/contacts/export${qs(params)}`, 'pulse-contacts.csv'),
  importPreview: ({ file, botId, mapping }) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('botId', String(botId));
    if (mapping) fd.append('mapping', JSON.stringify(mapping));
    return api('/contacts/import/preview', { method: 'POST', body: fd, allNumbers: true, timeoutMs: 60000 });
  },
  importCommit: ({ file, botId, mapping, enableAi, updateExisting }) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('botId', String(botId));
    if (mapping) fd.append('mapping', JSON.stringify(mapping));
    if (enableAi !== undefined) fd.append('enableAi', String(enableAi));
    if (updateExisting !== undefined) fd.append('updateExisting', String(updateExisting));
    return api('/contacts/import/commit', { method: 'POST', body: fd, allNumbers: true, timeoutMs: 120000 });
  },
};

export const analyticsApi = {
  // env: 'live' (real students) | 'test' (playground + test numbers)
  get: (days = 14, env = 'live') => api(`/analytics${qs({ days, env })}`),
};

export const adminApi = {
  sqliteGuard: () => api('/admin/sqlite-guard'),
  sqliteBackup: () => api('/admin/sqlite-backup', { method: 'POST' }),
  sqlitePurge: (password) => api('/admin/sqlite-purge', { method: 'POST', body: { password } }),
};

export const notificationsApi = {
  inbox: () => api('/notifications/inbox'),
  markRead: (id) => api(`/notifications/inbox/${id}/read`, { method: 'POST' }),
  markAllRead: () => api('/notifications/inbox/read-all', { method: 'POST' }),
};
