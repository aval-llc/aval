-- What was tried, and what was learned from it.
--
-- A replan that cannot see the previous attempt can only guess, and guessing
-- produces the loop this table exists to break: strategy A, fail, replan,
-- strategy A. Each row is one attempt at the objective — an execution, a
-- verification sweep, a repair, or a replan — carrying enough structure for the
-- next planning pass to choose differently on purpose.
--
-- `signature` is what makes repetition detectable: a digest of the tool, its
-- canonical arguments and the failure. `transient` is what keeps a legitimate
-- retry — a rate limit, a provider that has not caught up — from being read as
-- a loop. `progressed` records whether the attempt moved the objective at all,
-- which catches the subtler stagnation: different action, same nothing.

CREATE TABLE IF NOT EXISTS public.work_attempts (
  id                    text        PRIMARY KEY,
  organization_id       text        NOT NULL REFERENCES public.organizations(id),
  task_id               text        NOT NULL REFERENCES public.agent_tasks(id),
  employee_id           text,
  attempt_number        integer     NOT NULL,
  kind                  text        NOT NULL,
  started_at            timestamptz NOT NULL,
  ended_at              timestamptz,
  objective_snapshot    text,
  strategy              text,
  actions_json          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  tools_json            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  delegations_json      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  observations          text,
  result                text,
  outcome               text        NOT NULL,
  failure_reason        text,
  blocker_reason        text,
  transient             boolean     NOT NULL DEFAULT false,
  progressed            boolean     NOT NULL DEFAULT false,
  signature             text,
  learned               text,
  should_change         text,
  next_strategy         text,
  cost_cents            integer,
  tokens_used           integer,
  latency_ms            integer,
  external_effects_json jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at            timestamptz NOT NULL,
  CONSTRAINT work_attempts_kind CHECK (kind IN ('execution','verification','check_repair','replan')),
  CONSTRAINT work_attempts_outcome CHECK (outcome IN ('succeeded','failed','inconclusive','blocked')),
  CONSTRAINT work_attempts_number_positive CHECK (attempt_number >= 1)
);

CREATE INDEX IF NOT EXISTS work_attempts_task_idx
  ON public.work_attempts (organization_id, task_id, kind);

CREATE INDEX IF NOT EXISTS work_attempts_signature_idx
  ON public.work_attempts (organization_id, task_id, signature);

-- Attempt numbering is the budget. Unique per (task, kind) is what stops a
-- crash-and-resume from spending the same attempt twice, and what keeps the
-- three budgets — verification, repair, replan — counted separately rather than
-- draining one another.
CREATE UNIQUE INDEX IF NOT EXISTS work_attempts_number_uq
  ON public.work_attempts (task_id, kind, attempt_number);

-- Tenant table: default deny, read for anyone with organization access, write
-- for the roles that operate it. Attempt history is an append-and-correct
-- record, so DELETE is granted to no application role — losing it would mean
-- losing the reason a piece of work is where it is.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_attempts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO aval_app USING (aval_private.has_org_access(organization_id))',
      t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO aval_app WITH CHECK (aval_private.has_org_access(organization_id))',
      t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO aval_app USING (aval_private.has_org_access(organization_id)) WITH CHECK (aval_private.has_org_access(organization_id))',
      t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO aval_app, aval_worker', t);
  END LOOP;
END $$;
