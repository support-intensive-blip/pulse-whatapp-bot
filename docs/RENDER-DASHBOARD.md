# Dashboard and API on Render

Production dashboard and API: https://pulse-whatapp-bot.onrender.com

The root Dockerfile builds Vite in a separate stage, then copies its output into the Node/Express image. Express serves dashboard routes and static files with same-origin API calls. API and webhook failures remain API errors; they do not return the dashboard HTML.

## Existing service cutover

1. Keep the existing Render service, Supabase settings, and encryption secrets.
2. In Render → Settings, clear Root Directory. Set Dockerfile Path to `./Dockerfile` and Docker Build Context Directory to `.`. Include frontend and backend changes in auto-deploy.
3. Verify `/`, a dashboard deep link, `/health`, and authenticated API access on Render.
4. Deploy the compatibility Worker from frontend with Wrangler only after Render serves the dashboard. Its redirect mode forwards old dashboard URLs to Render while retaining existing API and authenticated webhook routing. Keep its scheduled webhook-queue wakeup. Do not change provider callback URLs as part of the dashboard move.
5. Sign in once at the Render URL. Browser sessions and push registrations are origin-specific.

## Five-minute wakeup

In your external cron service, schedule a GET to `https://pulse-whatapp-bot.onrender.com/health` with cron expression `*/5 * * * *`. Allow enough timeout for a cold start. No credentials are needed. This can keep the service active and consumes Render Free instance hours; it cannot prevent platform restarts or quota suspension.

The existing Worker cron wakes Render when it sees queued webhook work. It is separate from the optional unconditional five-minute health check.

## Rollback

Switch the compatibility Worker's DASHBOARD_REDIRECT to false and redeploy it before rolling Render back to a backend-only version. Existing Cloudflare webhook URLs and Supabase remain unchanged.
