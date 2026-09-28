-- A desktop ChatGPT plan's allowance for Aval's work resets daily.
--
-- desktop_model_runners (20260927000100_desktop_inference.sql) capped a
-- workspace's desktop inference at 500,000 tokens for the life of the runner:
-- nothing reset it, re-registering kept it, and an abandoned claim kept its
-- 128,000-token reservation forever. Codex reports ~50,000 tokens for even a
-- small call (its own instructions are in every turn), and one Aval One ->
-- Lead -> Specialist task makes about ten calls, so a runner exhausted its
-- lifetime cap within its first task and then refused every claim — work could
-- no longer be run or tested on the plan at all.
--
-- Now the cap is an allowance per day: `window_started_at` marks the current
-- day's window, and the claim route starts a new window once a day has passed.
-- The allowance is sized for about twenty tasks a day. It is still a guard
-- against a runaway loop, not a bill: the plan's own limits are ChatGPT's.

ALTER TABLE public.desktop_model_runners
  ADD COLUMN IF NOT EXISTS window_started_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.desktop_model_runners
  ALTER COLUMN token_limit SET DEFAULT 10000000;

-- Runners still on the old lifetime default get the daily allowance.
UPDATE public.desktop_model_runners SET token_limit = 10000000 WHERE token_limit = 500000;

-- Every runner starts a fresh window. Only the reservations of claims that are
-- still live are kept; the rest belonged to claims nobody will ever complete.
UPDATE public.desktop_model_runners runner SET
  tokens_used = 0,
  window_started_at = now(),
  tokens_reserved = COALESCE((
    SELECT sum(job.reserved_tokens) FROM public.desktop_model_jobs job
    WHERE job.organization_id = runner.organization_id AND job.status = 'claimed' AND job.lease_until > now()
  ), 0);
