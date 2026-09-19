-- Attempt budgets as configuration.
--
-- Three budgets bound how often Aval tries again: how long a provider is
-- waited on for proof (`verification`), how many times an answer may be
-- repaired against its completion condition (`check_repair`), and how many
-- times a goal may be re-planned (`replan`). They were three constants in
-- source, which meant one number governed every provider and every workflow,
-- and meant an employee's persistence toward its objective was fixed at build
-- time.
--
-- A null selector means "any". The most specific matching row wins, and the
-- selector weights in lib/agents/attempt-policy.ts are distinct powers of two
-- so no two shapes can tie. A workspace with no rows behaves exactly as the
-- shipped defaults, so this table is additive: absence is not a change.

CREATE TABLE IF NOT EXISTS public.attempt_policies (
  id                text        PRIMARY KEY,
  organization_id   text        NOT NULL REFERENCES public.organizations(id),
  kind              text        NOT NULL,
  provider          text,
  tool_name         text,
  work_type         text,
  risk_class        text,
  max_attempts      integer,
  max_elapsed_ms    integer,
  initial_delay_ms  integer     NOT NULL DEFAULT 0,
  backoff_strategy  text        NOT NULL DEFAULT 'fixed',
  backoff_factor    double precision NOT NULL DEFAULT 2,
  max_delay_ms      integer,
  on_exhausted      text        NOT NULL DEFAULT 'human_handoff',
  on_contradicted   text        NOT NULL DEFAULT 'human_handoff',
  enabled           boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  CONSTRAINT attempt_policies_kind CHECK (kind IN ('verification','check_repair','replan')),
  CONSTRAINT attempt_policies_backoff CHECK (backoff_strategy IN ('fixed','linear','exponential')),
  -- `fail` is available but is never a default: exhausting an automatic budget
  -- says Aval could not prove something, not that the work should be abandoned.
  CONSTRAINT attempt_policies_on_exhausted CHECK (on_exhausted IN ('human_handoff','replan','fail')),
  CONSTRAINT attempt_policies_on_contradicted CHECK (on_contradicted IN ('human_handoff','replan','fail')),
  CONSTRAINT attempt_policies_attempts_positive CHECK (max_attempts IS NULL OR max_attempts >= 1),
  CONSTRAINT attempt_policies_elapsed_positive CHECK (max_elapsed_ms IS NULL OR max_elapsed_ms >= 0),
  CONSTRAINT attempt_policies_delay_nonnegative CHECK (initial_delay_ms >= 0),
  CONSTRAINT attempt_policies_factor_positive CHECK (backoff_factor > 0)
);

CREATE INDEX IF NOT EXISTS attempt_policies_lookup_idx
  ON public.attempt_policies (organization_id, kind, enabled);

-- One row per selector shape per budget, so "most specific wins" never has two
-- candidates of equal specificity to choose between. NULLS NOT DISTINCT is what
-- makes the "any" selectors participate in the uniqueness rather than escaping it.
CREATE UNIQUE INDEX IF NOT EXISTS attempt_policies_selector_uq
  ON public.attempt_policies (organization_id, kind, provider, tool_name, work_type, risk_class)
  NULLS NOT DISTINCT;

-- Tenant table: default deny, read for anyone with organization access, write
-- for the roles that operate it. A policy is a governance record, so DELETE is
-- granted to no application role — a policy is disabled, not erased.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attempt_policies'] LOOP
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
