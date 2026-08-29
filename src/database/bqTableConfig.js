const TABLE_CONFIG = {
  users: {
    idField: 'id',
    timestamps: ['created_at'],
    fields: [
      'id', 'phone', 'name', 'display_name', 'persona', 'assistant_self_enabled',
      'assistant_contacts_enabled', 'guru_mode', 'chat_model_tier', 'created_at',
    ],
  },
  teams: {
    idField: 'id',
    timestamps: ['created_at'],
    fields: ['id', 'name', 'owner_user_id', 'created_at'],
  },
  dashboard_users: {
    idField: 'id',
    timestamps: ['created_at'],
    fields: [
      'id', 'email', 'password_hash', 'name', 'coach_phone', 'action_alert_phones',
      'role', 'is_active', 'team_id', 'created_at',
    ],
  },
  team_settings: {
    idField: 'team_id',
    timestamps: ['updated_at'],
    fields: [
      'team_id', 'openai_api_key_encrypted', 'assistant_persona', 'openai_model_fast',
      'openai_model_smart', 'chat_model_tier', 'knowledge_base_path', 'prompt_config',
      'use_owner_api_key', 'reply_delay_seconds', 'updated_at',
    ],
  },
  bot_accounts: {
    idField: 'id',
    timestamps: ['created_at', 'updated_at'],
    fields: [
      'id', 'dashboard_user_id', 'name', 'whatsapp_phone', 'status', 'session_client_id',
      'assistant_name', 'assistant_self_enabled', 'assistant_contacts_enabled', 'guru_mode',
      'last_error', 'last_whatsapp_phone', 'reply_delay_seconds', 'created_at', 'updated_at',
    ],
  },
  chat_profiles: {
    idField: 'id',
    timestamps: ['created_at', 'updated_at', 'conversation_ended_at'],
    fields: [
      'id', 'chat_id', 'owner_phone', 'contact_name', 'contact_phone', 'contact_role',
      'contact_responsibilities', 'contact_relations', 'chat_type', 'assistant_active',
      'assistant_pinned_on', 'paused_until', 'conversation_mode', 'context_topic', 'routing_slots',
      'conversation_ended_at', 'created_at', 'updated_at',
    ],
  },
  messages: {
    idField: 'id',
    timestamps: ['timestamp'],
    fields: ['id', 'user_id', 'chat_profile_id', 'role', 'content', 'source', 'wa_message_id', 'kb_meta', 'timestamp'],
  },
  conversation_summaries: {
    idField: 'id',
    timestamps: ['created_at'],
    fields: ['id', 'user_id', 'chat_profile_id', 'summary', 'created_at'],
  },
  action_items: {
    idField: 'id',
    timestamps: ['triggered_at', 'completed_at', 'created_at'],
    fields: [
      'id', 'bot_account_id', 'chat_profile_id', 'assigned_dashboard_user_id', 'source', 'title',
      'description', 'status', 'category', 'priority', 'dedupe_key', 'trigger_message_id',
      'triggered_at', 'completed_at', 'created_at',
    ],
  },
  token_usage: {
    idField: 'id',
    timestamps: ['created_at'],
    fields: [
      'id', 'chat_profile_id', 'owner_user_id', 'category', 'model', 'prompt_tokens',
      'completion_tokens', 'total_tokens', 'estimated_cost_usd', 'created_at',
    ],
  },
  notes: {
    idField: 'id',
    timestamps: ['created_at'],
    fields: ['id', 'user_id', 'content', 'created_at'],
  },
  reminders: {
    idField: 'id',
    timestamps: ['scheduled_time', 'created_at'],
    fields: ['id', 'user_id', 'message', 'scheduled_time', 'sent', 'created_at'],
  },
};

const HYDRATE_ORDER = [
  'users', 'teams', 'dashboard_users', 'team_settings', 'bot_accounts', 'chat_profiles',
  'messages', 'conversation_summaries', 'action_items', 'token_usage', 'notes', 'reminders',
];

const BQ_SYNC_TABLES = HYDRATE_ORDER.map((table) => ({ table }));

function getTableConfig(table) {
  return TABLE_CONFIG[table] || null;
}

module.exports = {
  TABLE_CONFIG,
  HYDRATE_ORDER,
  BQ_SYNC_TABLES,
  getTableConfig,
};
