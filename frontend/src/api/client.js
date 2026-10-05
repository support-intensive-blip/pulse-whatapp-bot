const API_BASE = '/api';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function getToken() {
  return localStorage.getItem('dashboard_token');
}

export async function api(path, options = {}) {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
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
      ...options,
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

async function downloadExport(path, filename) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error || 'Export failed', res.status);
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
  me: () => api('/auth/me'),
  changePassword: (currentPassword, newPassword) =>
    api('/auth/password', { method: 'PATCH', body: { currentPassword, newPassword } }),
};

export const botApi = {
  status: () => api('/bot'),
  start: () => api('/bot/start', { method: 'POST', timeoutMs: 30000 }),
  stop: () => api('/bot/stop', { method: 'POST', timeoutMs: 30000 }),
  updateSettings: (settings) => api('/bot/settings', { method: 'PATCH', body: settings }),
};

export const configApi = {
  vapidPublicKey: () => api('/notifications/vapid-public-key'),
  subscribePush: (subscription) =>
    api('/notifications/subscribe', { method: 'POST', body: { subscription } }),
  unsubscribePush: (endpoint) =>
    api('/notifications/unsubscribe', { method: 'POST', body: { endpoint } }),
};

export const dataApi = {
  stats: (fresh = false) => api(fresh ? `/stats?fresh=${Date.now()}` : '/stats'),
  conversations: (search = '', assistant = 'all') => {
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    if (assistant && assistant !== 'all') qs.set('assistant', assistant);
    const suffix = qs.toString();
    return api(`/conversations${suffix ? `?${suffix}` : ''}`, { timeoutMs: 45000 });
  },
  setChatAssistant: (chatId, active) =>
    api(`/conversations/${chatId}/assistant`, { method: 'PATCH', body: { active } }),
  contactChats: (contactKey, search = '') =>
    api(
      `/conversations/contact/${encodeURIComponent(contactKey)}/chats${
        search ? `?search=${encodeURIComponent(search)}` : ''
      }`
    ),
  syncConversations: (search = '') =>
    api(`/conversations/sync${search ? `?search=${encodeURIComponent(search)}` : ''}`, {
      method: 'POST',
    }),
  messages: (chatId, { limit = 200, since = null } = {}) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (since) qs.set('since', String(since));
    return api(`/conversations/${chatId}/messages?${qs}`);
  },
  sendMessage: (chatId, content) =>
    api(`/conversations/${chatId}/messages`, {
      method: 'POST',
      body: { content },
      timeoutMs: 45000,
    }),
  summarizeChat: (chatId) =>
    api(`/conversations/${chatId}/summarize`, { method: 'POST', timeoutMs: 90000 }),
  sendSummaryToWhatsApp: (chatId) =>
    api(`/conversations/${chatId}/summarize-to-whatsapp`, { method: 'POST', timeoutMs: 120000 }),
  escalateChat: (chatId) =>
    api(`/conversations/${chatId}/escalate`, { method: 'POST', timeoutMs: 30000 }),
  exportChats: (ids, format = 'json', filename, range = {}) => {
    const qs = new URLSearchParams({ format });
    if (ids?.length) qs.set('ids', ids.join(','));
    if (range?.from) qs.set('from', range.from);
    if (range?.to) qs.set('to', range.to);
    const base =
      filename ||
      (ids?.length === 1 ? `chat-${ids[0]}` : ids?.length ? 'chats-selected' : 'chats-all');
    return downloadExport(`/conversations/export?${qs}`, `${base}.${format}`);
  },
  actionItems: ({ status, coach, student, category } = {}) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (coach) qs.set('coach', coach);
    if (student) qs.set('student', student);
    if (category) qs.set('category', category);
    return api(`/action-items${qs.toString() ? `?${qs}` : ''}`);
  },
  updateActionItem: (id, status) => api(`/action-items/${id}`, { method: 'PATCH', body: { status } }),
  importContact: (body) => api('/conversations/import', { method: 'POST', body }),
  importContactCsv: (file) => {
    const fd = new FormData();
    fd.append('file', file);
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
