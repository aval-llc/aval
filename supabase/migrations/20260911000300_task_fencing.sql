-- Monotonic task-lease fencing. The owner token remains useful for tracing;
-- the generation makes stale checkpoints impossible even if an owner token is
-- accidentally reused after a lease expires.

ALTER TABLE public.agent_tasks
  ADD COLUMN IF NOT EXISTS lease_generation integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS agent_tasks_org_status_lease_idx
  ON public.agent_tasks (organization_id, status, lease_expires_at, next_attempt_at);
