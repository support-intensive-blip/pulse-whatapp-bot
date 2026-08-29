const { initializeDatabaseAsync, getDatabase } = require('../src/database/db');
const { estimateCostUsd } = require('../src/config/modelPricing');

(async () => {
  await initializeDatabaseAsync();
  const db = getDatabase();

  const total = db
    .prepare(
      `SELECT COUNT(*) AS c,
              SUM(total_tokens) AS tokens,
              SUM(estimated_cost_usd) AS stored_cost,
              SUM(prompt_tokens) AS prompt,
              SUM(completion_tokens) AS completion
       FROM token_usage`
    )
    .get();

  const rows = db
    .prepare('SELECT id, model, prompt_tokens, completion_tokens, estimated_cost_usd, category FROM token_usage')
    .all();

  let recomputed = 0;
  for (const row of rows) {
    recomputed += estimateCostUsd(row.model, row.prompt_tokens, row.completion_tokens);
  }

  const models = db
    .prepare(
      `SELECT model, COUNT(*) AS c, SUM(total_tokens) AS t, SUM(estimated_cost_usd) AS cost
       FROM token_usage GROUP BY model ORDER BY cost DESC LIMIT 15`
    )
    .all();

  const top = db
    .prepare(
      `SELECT id, category, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd
       FROM token_usage ORDER BY total_tokens DESC LIMIT 10`
    )
    .all();

  console.log(JSON.stringify({ total, recomputed, models, top }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
