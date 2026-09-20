-- Expertise, separated from identity.
--
-- The eight specialists conflated the two. "Maintenance" was at once an
-- identity, a permission envelope, a prompt fragment and a tool subset, which
-- is why a recurring HVAC complaint that also needed vendor coordination and an
-- escalation had only two shapes: one over-broad agent, or four separate bots
-- the customer had to wire together themselves.
--
-- Here the employee is the persistent worker and expertise is loaded for the
-- work in front of it. The routing metadata is deliberately small and the
-- instructions deliberately separate, so selection can consider a large
-- catalogue while only the chosen profiles are ever read.
--
-- `organization_id` is nullable: null means a profile Aval ships, which every
-- workspace can see. A workspace may author its own, and may shadow a shipped
-- slug with its own version.

CREATE TABLE IF NOT EXISTS public.expertise_profiles (
  id                          text        PRIMARY KEY,
  organization_id             text        REFERENCES public.organizations(id),
  slug                        text        NOT NULL,
  name                        text        NOT NULL,
  description                 text        NOT NULL,
  capability_tags_json        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  domains_json                jsonb       NOT NULL DEFAULT '[]'::jsonb,
  routing_signals_json        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  required_capabilities_json  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  instructions                text        NOT NULL DEFAULT '',
  risk_ceiling                text        NOT NULL DEFAULT 'low',
  version                     integer     NOT NULL DEFAULT 1,
  enabled                     boolean     NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL,
  updated_at                  timestamptz NOT NULL,
  CONSTRAINT expertise_profiles_risk CHECK (risk_ceiling IN ('low','medium','high','critical')),
  CONSTRAINT expertise_profiles_slug_shape CHECK (slug = lower(slug) AND length(slug) BETWEEN 2 AND 64)
);

CREATE INDEX IF NOT EXISTS expertise_profiles_lookup_idx
  ON public.expertise_profiles (organization_id, enabled);

-- A workspace may shadow a shipped slug with its own; it may not hold two of
-- its own. NULLS NOT DISTINCT is what makes the shipped set unique too.
CREATE UNIQUE INDEX IF NOT EXISTS expertise_profiles_slug_uq
  ON public.expertise_profiles (organization_id, slug) NULLS NOT DISTINCT;

CREATE TABLE IF NOT EXISTS public.employee_expertise (
  id               text        PRIMARY KEY,
  organization_id  text        NOT NULL REFERENCES public.organizations(id),
  employee_id      text        NOT NULL REFERENCES public.ai_employees(id),
  expertise_id     text        NOT NULL REFERENCES public.expertise_profiles(id),
  pinned           boolean     NOT NULL DEFAULT false,
  granted_by       text        NOT NULL,
  created_at       timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS employee_expertise_lookup_idx ON public.employee_expertise (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS employee_expertise_uq
  ON public.employee_expertise (employee_id, expertise_id);

-- Why a particular expertise was loaded for a particular piece of work. A
-- routing decision that cannot be inspected is indistinguishable from a guess.
CREATE TABLE IF NOT EXISTS public.expertise_selections (
  id               text        PRIMARY KEY,
  organization_id  text        NOT NULL REFERENCES public.organizations(id),
  task_id          text        NOT NULL REFERENCES public.agent_tasks(id),
  employee_id      text,
  candidates_json  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  selected_json    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  signals_json     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  decided_by       text        NOT NULL,
  model_provider   text,
  model_name       text,
  confidence       double precision,
  overridden_by    text,
  created_at       timestamptz NOT NULL,
  CONSTRAINT expertise_selections_decided_by CHECK (decided_by IN ('deterministic','model','user')),
  CONSTRAINT expertise_selections_confidence CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX IF NOT EXISTS expertise_selections_task_idx
  ON public.expertise_selections (organization_id, task_id);

-- Tenant tables. `expertise_profiles` is the exception: a row with a null
-- organization is one Aval ships, readable by every workspace and writable by
-- none of them.
ALTER TABLE public.expertise_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expertise_profiles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expertise_profiles_select ON public.expertise_profiles;
CREATE POLICY expertise_profiles_select ON public.expertise_profiles FOR SELECT TO aval_app
  USING (organization_id IS NULL OR aval_private.has_org_access(organization_id));
DROP POLICY IF EXISTS expertise_profiles_insert ON public.expertise_profiles;
CREATE POLICY expertise_profiles_insert ON public.expertise_profiles FOR INSERT TO aval_app
  WITH CHECK (organization_id IS NOT NULL
              AND aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager']));
DROP POLICY IF EXISTS expertise_profiles_update ON public.expertise_profiles;
CREATE POLICY expertise_profiles_update ON public.expertise_profiles FOR UPDATE TO aval_app
  USING (organization_id IS NOT NULL
         AND aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager']))
  WITH CHECK (organization_id IS NOT NULL
              AND aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager']));
DROP POLICY IF EXISTS expertise_profiles_worker_all ON public.expertise_profiles;
CREATE POLICY expertise_profiles_worker_all ON public.expertise_profiles FOR ALL TO aval_worker
  USING (organization_id IS NULL OR organization_id = aval_private.current_organization_id())
  WITH CHECK (organization_id = aval_private.current_organization_id());
GRANT SELECT, INSERT, UPDATE ON public.expertise_profiles TO aval_app, aval_worker;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_expertise','expertise_selections'] LOOP
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
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_worker_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO aval_worker USING (organization_id = aval_private.current_organization_id()) WITH CHECK (organization_id = aval_private.current_organization_id())',
      t || '_worker_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO aval_app, aval_worker', t);
  END LOOP;
END $$;

-- Granting and withdrawing expertise is an ordinary administrative act.
DROP POLICY IF EXISTS employee_expertise_delete ON public.employee_expertise;
CREATE POLICY employee_expertise_delete ON public.employee_expertise FOR DELETE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager']));
GRANT DELETE ON public.employee_expertise TO aval_app, aval_worker;
