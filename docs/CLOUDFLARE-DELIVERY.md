# Cloudflare delivery and recovery

Dashboard: https://pulse-dashboard.support-intensive.workers.dev

Gallabox webhook per number: `https://pulse-dashboard.support-intensive.workers.dev/webhooks/gallabox/<botId>`.
Keep each number's existing webhook signing secret and event subscriptions. Replace its existing destination rather than adding a second subscription.

## Required deployment settings

Cloudflare secrets: SUPABASE_URL, SUPABASE_SECRET_KEY, ENCRYPTION_KEY (same encryption secret used by the backend, including its JWT_SECRET fallback). These are server secrets, never Vite variables.
Cloudflare BACKEND_ORIGIN points to the Render backend. The cron checks pending jobs each minute and contacts /health only when work exists.

Render: SUPABASE_DB_URL must point to the same database as the Worker. For free ephemeral compute use SUPABASE_ENABLED=true and SQLITE_ENABLED=false, with SUPABASE_URL and SUPABASE_SECRET_KEY configured. Confirm the existing data is present in Supabase before changing storage settings. The existing render.yaml is a legacy paid-service blueprint; do not reapply it to provision a free service unchanged.

Apply backend/supabase/reliable-inbox.sql before deploying the backend. The current company database has this schema applied. The inbox has RLS enabled and no public-client access.

## Processing

Cloudflare validates the exact signed bytes before inserting into Supabase. A successful response means durable acceptance, not delivery to WhatsApp. Duplicate webhook identities do not reset completed jobs. Database errors return 503 for provider retry.

Render claims jobs with a renewable 10-minute lease. Expired leases are reclaimable after restart. Failed jobs retry with increasing delays capped at five minutes. Processing is serial per backend process, and earlier incomplete jobs block later jobs for the same bot to preserve ordering. A failed bot can therefore accumulate a backlog; operators must monitor it.

Durable jobs bypass the volatile message batching timer and await AI processing and sending. Saved AI results and send checkpoints survive restarts. Completed inbox payloads and signatures are cleared; identifiers remain for deduplication. Pending payloads and saved replies contain student data and require the company's normal retention and access policies.

This is at-least-once processing. If Gallabox accepts a send but the response or database checkpoint is lost, retrying can produce a duplicate. No exactly-once delivery guarantee is claimed. Completed means processing finished (or bot rules intentionally suppressed the answer), not that the student's device confirmed delivery. Provider delivery-failure events retain existing logging behavior.

## Verification

Run `node scripts/test-reliable-inbox.js` from backend. It uses a fake database and sends no WhatsApp messages.
Live validation used signed Reliability.Probe events, which do not produce student replies. Confirm these jobs reach completed after the Render deployment. `/health` includes reliableInbox=true when the deployed version has its database connection configured.

Before cutover, verify a real test-number message through Gallabox, then repeat with Render asleep. Do not declare delivery migration complete while Gallabox still targets Render directly.

Inspect backlog using a server-side SQL session:

```sql
select state, count(*), min(created_at) as oldest from public.webhook_inbox group by state;
select id, bot_id, attempts, last_error, next_attempt_at from public.webhook_inbox where state <> 'completed' order by created_at;
```

Render Free suspension, quotas, and provider outages can delay replies indefinitely. The queue preserves accepted work; it does not establish a maximum reply time.
