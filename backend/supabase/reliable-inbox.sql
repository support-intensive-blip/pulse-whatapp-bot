CREATE TABLE IF NOT EXISTS public.webhook_inbox (
  id text PRIMARY KEY,
  bot_id bigint NOT NULL,
  event_name text NOT NULL,
  raw_body text NOT NULL,
  signature text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','completed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  sent jsonb NOT NULL DEFAULT '{}',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE public.webhook_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.webhook_inbox FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_inbox TO service_role;
CREATE INDEX IF NOT EXISTS webhook_inbox_pending ON public.webhook_inbox(state, next_attempt_at, created_at);
NOTIFY pgrst, 'reload schema';
