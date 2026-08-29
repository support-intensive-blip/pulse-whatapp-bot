function isBigQueryPrimary() {
  return process.env.BQ_ENABLED === 'true' && process.env.SQLITE_ENABLED === 'false';
}

function isSqlitePersisted() {
  return process.env.SQLITE_ENABLED !== 'false';
}

function getServerSource() {
  return process.env.SERVER_SOURCE || process.env.HOSTNAME || 'gcp';
}

module.exports = {
  isBigQueryPrimary,
  isSqlitePersisted,
  getServerSource,
};
