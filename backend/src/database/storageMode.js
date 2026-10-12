function isSupabaseEnabled() {
  return process.env.SUPABASE_ENABLED === 'true';
}

// Supabase-primary: SQLite runs in memory as a cache, hydrated from Supabase on every boot.
function isSupabasePrimary() {
  return isSupabaseEnabled() && process.env.SQLITE_ENABLED === 'false';
}

function isBigQueryPrimary() {
  return (
    process.env.BQ_ENABLED === 'true' &&
    process.env.SQLITE_ENABLED === 'false' &&
    !isSupabaseEnabled()
  );
}

function isSqlitePersisted() {
  return process.env.SQLITE_ENABLED !== 'false';
}

function getServerSource() {
  return process.env.SERVER_SOURCE || process.env.HOSTNAME || 'gcp';
}

module.exports = {
  isSupabaseEnabled,
  isSupabasePrimary,
  isBigQueryPrimary,
  isSqlitePersisted,
  getServerSource,
};
