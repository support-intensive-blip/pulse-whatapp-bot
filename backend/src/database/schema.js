const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  display_name TEXT,
  persona TEXT,
  assistant_self_enabled INTEGER NOT NULL DEFAULT 1,
  assistant_contacts_enabled INTEGER NOT NULL DEFAULT 1,
  guru_mode INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  owner_phone TEXT NOT NULL,
  contact_name TEXT,
  contact_phone TEXT,
  contact_role TEXT,
  contact_responsibilities TEXT,
  contact_relations TEXT,
  chat_type TEXT NOT NULL DEFAULT 'contact',
  assistant_active INTEGER NOT NULL DEFAULT 1,
  assistant_pinned_on INTEGER NOT NULL DEFAULT 0,
  paused_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  chat_profile_id INTEGER,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (chat_profile_id) REFERENCES chat_profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  scheduled_time TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  chat_profile_id INTEGER,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (chat_profile_id) REFERENCES chat_profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS student_user_memory (
  phone TEXT PRIMARY KEY NOT NULL,
  preferences TEXT,
  last_conversation_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id);
CREATE INDEX IF NOT EXISTS idx_reminders_user_id ON reminders(user_id);
CREATE INDEX IF NOT EXISTS idx_reminders_scheduled ON reminders(scheduled_time);
CREATE INDEX IF NOT EXISTS idx_summaries_user_id ON conversation_summaries(user_id);

CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_profile_id INTEGER,
  owner_user_id INTEGER,
  category TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (chat_profile_id) REFERENCES chat_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_token_usage_chat ON token_usage(chat_profile_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_owner ON token_usage(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_category ON token_usage(category);

CREATE TABLE IF NOT EXISTS dashboard_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  coach_phone TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bot_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dashboard_user_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT 'My WhatsApp Bot',
  whatsapp_phone TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  session_client_id TEXT NOT NULL,
  assistant_name TEXT DEFAULT 'JahNavi',
  assistant_self_enabled INTEGER NOT NULL DEFAULT 1,
  assistant_contacts_enabled INTEGER NOT NULL DEFAULT 1,
  guru_mode INTEGER NOT NULL DEFAULT 0,
  last_qr TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dashboard_user_id) REFERENCES dashboard_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS action_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_account_id INTEGER NOT NULL,
  chat_profile_id INTEGER,
  assigned_dashboard_user_id INTEGER,
  source TEXT NOT NULL DEFAULT 'system',
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (bot_account_id) REFERENCES bot_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (chat_profile_id) REFERENCES chat_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_dashboard_user_id) REFERENCES dashboard_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_accounts_user ON bot_accounts(dashboard_user_id);
CREATE INDEX IF NOT EXISTS idx_action_items_bot ON action_items(bot_account_id);
CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(status);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dashboard_user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dashboard_user_id) REFERENCES dashboard_users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(dashboard_user_id);
`;

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS chat_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL UNIQUE,
  owner_phone TEXT NOT NULL,
  contact_name TEXT,
  contact_role TEXT,
  contact_responsibilities TEXT,
  contact_relations TEXT,
  chat_type TEXT NOT NULL DEFAULT 'contact',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

module.exports = { SCHEMA_SQL, MIGRATION_SQL };
