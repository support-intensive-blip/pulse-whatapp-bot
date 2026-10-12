const { createClient } = require('@supabase/supabase-js');

let client = null;

// Server-side only: the secret (service role) key bypasses RLS. Never ship it to the dashboard.
function getSupabaseKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function isConfigured() {
  return Boolean(process.env.SUPABASE_URL && getSupabaseKey());
}

function getClient() {
  if (client) return client;
  if (!isConfigured()) {
    throw new Error('Supabase is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY');
  }
  client = createClient(process.env.SUPABASE_URL, getSupabaseKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

module.exports = { getClient, isConfigured };
