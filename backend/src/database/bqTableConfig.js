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
    timestamps: ['created_at', 'updated_at'],
    fields: ['id', 'name', 'description', 'owner_user_id', 'is_active', 'created_at', 'updated_at'],
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
      'id', 'team_id', 'dashboard_user_id', 'name', 'description', 'whatsapp_phone', 'status',
      'is_active', 'ai_status', 'default_ai_on', 'session_client_id', 'gallabox_api_key_enc',
      'gallabox_api_secret_enc', 'gallabox_channel_id', 'gallabox_account_id', 'webhook_secret_enc',
      'system_prompt', 'knowledge_resource_ids', 'assistant_name', 'assistant_self_enabled',
      'assistant_contacts_enabled', 'guru_mode', 'last_error', 'last_whatsapp_phone',
      'reply_delay_seconds', 'batch_delay_seconds', 'context_window_minutes', 'test_mode_enabled',
      'test_numbers', 'last_inbound_at', 'created_at', 'updated_at',
    ],
  },
  chat_profiles: {
    idField: 'id',
    timestamps: ['created_at', 'updated_at', 'conversation_ended_at'],
    fields: [
      'id', 'chat_id', 'owner_phone', 'contact_name', 'contact_phone', 'contact_role',
      'contact_responsibilities', 'contact_relations', 'chat_type', 'assistant_active',
      'assistant_pinned_on', 'paused_until', 'conversation_mode', 'context_topic', 'routing_slots',
      'conversation_ended_at', 'tags', 'assigned_user_id', 'contact_notes', 'import_source',
      'created_at', 'updated_at',
    ],
  },
  messages: {
    idField: 'id',
    timestamps: ['timestamp'],
    fields: ['id', 'user_id', 'chat_profile_id', 'role', 'content', 'source', 'wa_message_id', 'kb_meta', 'environment', 'timestamp'],
  },
  conversation_summaries: {
    idField: 'id',
    timestamps: ['created_at'],
    fields: ['id', 'user_id', 'chat_profile_id', 'summary', 'created_at'],
  },
  action_items: {
    idField: 'id',
    timestamps: ['triggered_at', 'completed_at', 'created_at', 'updated_at'],
    fields: [
      'id', 'bot_account_id', 'chat_profile_id', 'assigned_dashboard_user_id', 'source', 'title',
      'description', 'status', 'category', 'priority', 'dedupe_key', 'trigger_message_id',
      'due_date', 'notes', 'resolution', 'created_by_user_id',
      'triggered_at', 'completed_at', 'created_at', 'updated_at',
    ],
  },
  bot_prompt_versions: {
    idField: 'id',
    timestamps: ['created_at'],
    fields: ['id', 'bot_account_id', 'content', 'note', 'created_by', 'created_at'],
  },
  knowledge_resources: {
    idField: 'id',
    timestamps: ['created_at', 'updated_at', 'deleted_at'],
    fields: [
      'id', 'team_id', 'title', 'kind', 'content', 'source_path', 'filename', 'content_hash',
      'created_by', 'deleted_at', 'created_at', 'updated_at',
    ],
  },
  audit_log: {
    idField: 'id',
    timestamps: ['created_at'],
    fields: ['id', 'actor_user_id', 'team_id', 'action', 'target_type', 'target_id', 'meta', 'created_at'],
  },
  token_usage: {
    idField: 'id',
    timestamps: ['created_at'],
    fields: [
      'id', 'chat_profile_id', 'owner_user_id', 'bot_account_id', 'team_id', 'environment', 'category', 'model', 'prompt_tokens',
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
  'bot_prompt_versions', 'knowledge_resources', 'audit_log',
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
