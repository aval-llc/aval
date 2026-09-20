-- AI employees as durable organizational actors.
--
-- The eight specialists that preceded this were a union type in source:
-- `PersonaId` in lib/ask-aval/persona-catalog.ts, hand-copied into three other
-- places. The roster was therefore a property of the build, and a customer who
-- wanted a "Turnover Coordinator" needed a release. Here `role` is text,
-- because the set of jobs a property manager needs doing is not knowable at
-- compile time and never was.
--
-- Nothing in this table encodes how many employees a workspace may have.
-- `organizations.ai_employee_limit` carries that as configurable policy, and
-- null means no limit — a ceiling is a commercial decision, not a property of
-- the runtime.
--
-- Scopes are relational rather than folded into one opaque prompt, so what an
-- employee may reach is enforced in the backend and legible to whoever granted
-- it. Absence is never permission: an employee with no rows of a given kind
-- reaches nothing of that kind.

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS ai_employee_limit integer;

CREATE TABLE IF NOT EXISTS public.ai_employees (
  id                          text        PRIMARY KEY,
  organization_id             text        NOT NULL REFERENCES public.organizations(id),
  name                        text        NOT NULL,
  role                        text        NOT NULL,
  description                 text,
  objective                   text,
  instructions                text,
  status                      text        NOT NULL DEFAULT 'draft',
  autonomy_mode               text        NOT NULL DEFAULT 'supervised',
  approval_policy             text        NOT NULL DEFAULT 'standard',
  spend_limit_cents           integer,
  risk_ceiling                text        NOT NULL DEFAULT 'low',
  memory_scope                text        NOT NULL DEFAULT 'work',
  may_communicate_externally  boolean     NOT NULL DEFAULT false,
  may_delegate                boolean     NOT NULL DEFAULT false,
  created_by                  text        NOT NULL,
  created_at                  timestamptz NOT NULL,
  updated_at                  timestamptz NOT NULL,
  CONSTRAINT ai_employees_status CHECK (status IN ('draft','active','paused','archived')),
  CONSTRAINT ai_employees_autonomy CHECK (autonomy_mode IN ('supervised','assisted','autonomous')),
  CONSTRAINT ai_employees_risk CHECK (risk_ceiling IN ('low','medium','high','critical')),
  CONSTRAINT ai_employees_memory_scope CHECK (memory_scope IN ('organization','property','work')),
  CONSTRAINT ai_employees_spend_nonnegative CHECK (spend_limit_cents IS NULL OR spend_limit_cents >= 0),
  CONSTRAINT ai_employees_name_present CHECK (length(trim(name)) > 0),
  CONSTRAINT ai_employees_role_present CHECK (length(trim(role)) > 0)
);

CREATE INDEX IF NOT EXISTS ai_employees_org_idx ON public.ai_employees (organization_id, status);

-- One name per workspace. Duplicates are permitted by the architecture but not
-- by this table: a directory holding two employees called Maya cannot be used
-- to decide which one is waiting on you.
CREATE UNIQUE INDEX IF NOT EXISTS ai_employees_org_name_uq
  ON public.ai_employees (organization_id, name);

CREATE TABLE IF NOT EXISTS public.ai_employee_scopes (
  id               text        PRIMARY KEY,
  organization_id  text        NOT NULL REFERENCES public.organizations(id),
  employee_id      text        NOT NULL REFERENCES public.ai_employees(id),
  scope_kind       text        NOT NULL,
  value            text        NOT NULL,
  granted_by       text        NOT NULL,
  created_at       timestamptz NOT NULL,
  -- The kinds are an internal taxonomy and are constrained. The values are not:
  -- a data domain or a work type is something a customer names.
  CONSTRAINT ai_employee_scopes_kind CHECK (scope_kind IN ('property','connection','capability','work_type','data_domain','delegate_to')),
  CONSTRAINT ai_employee_scopes_value_present CHECK (length(trim(value)) > 0)
);

CREATE INDEX IF NOT EXISTS ai_employee_scopes_lookup_idx
  ON public.ai_employee_scopes (employee_id, scope_kind);
CREATE UNIQUE INDEX IF NOT EXISTS ai_employee_scopes_grant_uq
  ON public.ai_employee_scopes (employee_id, scope_kind, value);

-- Tenant tables: default deny, read for anyone with organization access, write
-- for the roles that operate the workspace. An employee is archived rather than
-- deleted — its Work and audit trail outlive it — so no application role gets
-- DELETE on the employee itself. A scope grant is revocable, so that one does.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_employees','ai_employee_scopes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO aval_app USING (aval_private.has_org_access(organization_id))',
      t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO aval_app WITH CHECK (aval_private.has_org_role(organization_id, ARRAY[''org_admin'',''regional_manager'']))',
      t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO aval_app USING (aval_private.has_org_role(organization_id, ARRAY[''org_admin'',''regional_manager''])) WITH CHECK (aval_private.has_org_role(organization_id, ARRAY[''org_admin'',''regional_manager'']))',
      t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO aval_app, aval_worker', t);
    -- The worker reads employees to run their Work; it never creates or
    -- re-scopes one, but FOR ALL is the shape every other worker policy uses
    -- and the transaction-local organization is what bounds it.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_worker_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO aval_worker USING (organization_id = aval_private.current_organization_id()) WITH CHECK (organization_id = aval_private.current_organization_id())',
      t || '_worker_all', t);
  END LOOP;
END $$;

-- Revoking a grant is an ordinary administrative act, so scopes may be deleted.
DROP POLICY IF EXISTS ai_employee_scopes_delete ON public.ai_employee_scopes;
CREATE POLICY ai_employee_scopes_delete ON public.ai_employee_scopes FOR DELETE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager']));
GRANT DELETE ON public.ai_employee_scopes TO aval_app, aval_worker;
