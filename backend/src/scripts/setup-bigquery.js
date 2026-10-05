require('dotenv').config();
const bigqueryService = require('../services/bigqueryService');

async function main() {
  if (!bigqueryService.isEnabled()) {
    console.error('Set BQ_ENABLED=true and GCP_PROJECT_ID in .env first');
    process.exit(1);
  }

  const result = await bigqueryService.ensureAllTables();
  console.log('BigQuery ready:', result);
}

main().catch((error) => {
  console.error('BigQuery setup failed:', error.message);
  process.exit(1);
});
