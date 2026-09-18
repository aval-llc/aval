-- Bind human approvals to resource scope and replace broad generated write
-- policies on security-sensitive tables. The application role never bypasses
-- RLS; service callbacks and cron use the separately scoped aval_worker role.

ALTER TABLE public.agent_approvals ADD COLUMN IF NOT EXISTS property_id text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_approvals_org_property_fk'
  ) THEN
    ALTER TABLE public.agent_approvals
      ADD CONSTRAINT agent_approvals_org_property_fk
      FOREIGN KEY (organization_id, property_id)
      REFERENCES public.properties(organization_id, id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS agent_approvals_org_property_status_idx
  ON public.agent_approvals (organization_id, property_id, status);

CREATE OR REPLACE FUNCTION aval_private.can_access_property(target_org text, target_property text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT target_org = aval_private.current_organization_id() AND EXISTS (
    SELECT 1
    FROM public.properties property_row
    JOIN public.access_grants grant_row
      ON grant_row.organization_id = property_row.organization_id
     AND grant_row.principal_id = aval_private.current_principal_id()
     AND grant_row.revoked_at IS NULL
     AND (grant_row.expires_at IS NULL OR grant_row.expires_at > statement_timestamp())
     AND (
       grant_row.organization_scope
       OR grant_row.property_id = property_row.id
       OR grant_row.ownership_entity_id = property_row.ownership_entity_id
       OR grant_row.portfolio_id = property_row.portfolio_id
       OR grant_row.region_id = property_row.region_id
     )
    JOIN public.principals principal
      ON principal.id = grant_row.principal_id AND principal.status = 'active'
    WHERE property_row.organization_id = target_org
      AND property_row.id = target_property
  )
$$;

CREATE OR REPLACE FUNCTION aval_private.can_manage_property(target_org text, target_property text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT target_org = aval_private.current_organization_id() AND EXISTS (
    SELECT 1
    FROM public.properties property_row
    JOIN public.access_grants grant_row
      ON grant_row.organization_id = property_row.organization_id
     AND grant_row.principal_id = aval_private.current_principal_id()
     AND grant_row.role = ANY(ARRAY['org_admin','regional_manager','property_manager','operator'])
     AND grant_row.revoked_at IS NULL
     AND (grant_row.expires_at IS NULL OR grant_row.expires_at > statement_timestamp())
     AND (
       grant_row.organization_scope
       OR grant_row.property_id = property_row.id
       OR grant_row.ownership_entity_id = property_row.ownership_entity_id
       OR grant_row.portfolio_id = property_row.portfolio_id
       OR grant_row.region_id = property_row.region_id
     )
    JOIN public.principals principal
      ON principal.id = grant_row.principal_id AND principal.status = 'active'
    WHERE property_row.organization_id = target_org
      AND property_row.id = target_property
  )
$$;

CREATE OR REPLACE FUNCTION aval_private.can_decide_approval(
  target_org text,
  target_approval text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT target_org = aval_private.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM public.agent_approvals approval
      JOIN public.access_grants grant_row
        ON grant_row.organization_id = approval.organization_id
       AND grant_row.principal_id = aval_private.current_principal_id()
      JOIN public.principals principal
        ON principal.id = grant_row.principal_id
       AND principal.status = 'active'
      LEFT JOIN public.properties property_row
        ON property_row.organization_id = approval.organization_id
       AND property_row.id = approval.property_id
      WHERE approval.organization_id = target_org
        AND approval.id = target_approval
        AND grant_row.role IN ('org_admin', 'approver')
        AND grant_row.revoked_at IS NULL
        AND (grant_row.expires_at IS NULL OR grant_row.expires_at > statement_timestamp())
        AND (
          grant_row.organization_scope
          OR (
            approval.property_id IS NOT NULL
            AND (
              grant_row.property_id = property_row.id
              OR grant_row.ownership_entity_id = property_row.ownership_entity_id
              OR grant_row.portfolio_id = property_row.portfolio_id
              OR grant_row.region_id = property_row.region_id
            )
          )
        )
        AND (
          approval.amount_cents IS NULL
          OR grant_row.role = 'org_admin'
          OR EXISTS (
            SELECT 1
            FROM public.approval_authorities authority
            WHERE authority.organization_id = approval.organization_id
              AND authority.access_grant_id = grant_row.id
              AND authority.action IN ('*', approval.tool_name)
              AND authority.currency = coalesce(approval.currency, 'USD')
              AND authority.maximum_amount_cents >= approval.amount_cents
          )
        )
    )
$$;

-- Approval proposals are created by operators and are thereafter immutable
-- except for status/counter updates by an authorized approver.
DROP POLICY IF EXISTS agent_approvals_insert ON public.agent_approvals;
CREATE POLICY agent_approvals_insert ON public.agent_approvals FOR INSERT TO aval_app
  WITH CHECK (
    aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator'])
    OR (property_id IS NOT NULL AND aval_private.can_manage_property(organization_id, property_id))
  );
DROP POLICY IF EXISTS agent_approvals_update ON public.agent_approvals;
CREATE POLICY agent_approvals_update ON public.agent_approvals FOR UPDATE TO aval_app
  USING (
    aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator'])
    OR aval_private.can_decide_approval(organization_id, id)
  )
  WITH CHECK (
    aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator'])
    OR aval_private.can_decide_approval(organization_id, id)
  );
DROP POLICY IF EXISTS agent_approvals_delete ON public.agent_approvals;

DROP POLICY IF EXISTS agent_approval_decisions_insert ON public.agent_approval_decisions;
CREATE POLICY agent_approval_decisions_insert ON public.agent_approval_decisions FOR INSERT TO aval_app
  WITH CHECK (
    organization_id = aval_private.current_organization_id()
    AND user_id = aval_private.current_principal_id()
    AND aval_private.can_decide_approval(organization_id, approval_id)
  );
DROP POLICY IF EXISTS agent_approval_decisions_update ON public.agent_approval_decisions;
DROP POLICY IF EXISTS agent_approval_decisions_delete ON public.agent_approval_decisions;

-- These tables are visible within a workspace but only organization
-- administrators may change their configuration.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organization_members',
    'integration_connections',
    'oauth_states',
    'integration_sync_state',
    'communication_settings',
    'communication_poll_sources',
    'agent_execution_policies'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_select', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_insert', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_update', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_delete', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO aval_app USING (aval_private.has_org_access(organization_id))',
      table_name || '_select', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO aval_app WITH CHECK (aval_private.has_org_role(organization_id, ARRAY[''org_admin'']))',
      table_name || '_insert', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO aval_app USING (aval_private.has_org_role(organization_id, ARRAY[''org_admin''])) WITH CHECK (aval_private.has_org_role(organization_id, ARRAY[''org_admin'']))',
      table_name || '_update', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO aval_app USING (aval_private.has_org_role(organization_id, ARRAY[''org_admin'']))',
      table_name || '_delete', table_name
    );
  END LOOP;
END $$;

-- Invitation codes are redeemed through a narrowly-scoped SECURITY DEFINER
-- function; direct invitation access remains administrator-only.
DROP POLICY IF EXISTS organization_invitations_select ON public.organization_invitations;
DROP POLICY IF EXISTS organization_invitations_insert ON public.organization_invitations;
DROP POLICY IF EXISTS organization_invitations_update ON public.organization_invitations;
DROP POLICY IF EXISTS organization_invitations_delete ON public.organization_invitations;
CREATE POLICY organization_invitations_select ON public.organization_invitations FOR SELECT TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin']));
CREATE POLICY organization_invitations_insert ON public.organization_invitations FOR INSERT TO aval_app
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin']));
CREATE POLICY organization_invitations_update ON public.organization_invitations FOR UPDATE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin']))
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin']));
CREATE POLICY organization_invitations_delete ON public.organization_invitations FOR DELETE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin']));

-- Billing rows are read by the usage screen and written only by verified
-- Stripe callbacks running as aval_worker.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['subscriptions', 'token_top_ups'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_select', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_insert', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_update', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_delete', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO aval_app USING (aval_private.has_org_access(organization_id))',
      table_name || '_select', table_name
    );
  END LOOP;
END $$;

-- Append-only evidence cannot be rewritten or deleted through the application
-- role. The worker receives its own tenant-scoped policy in the prior migration.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'answer_audit_log',
    'agent_task_steps',
    'agent_financial_events',
    'agent_checks',
    'agent_memory',
    'agent_plan_nodes',
    'agent_model_contexts'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_update', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_delete', table_name);
  END LOOP;
END $$;

-- A user may mutate only their own onboarding row, even when they can see a
-- workspace shared with other users.
DROP POLICY IF EXISTS user_onboarding_insert ON public.user_onboarding;
CREATE POLICY user_onboarding_insert ON public.user_onboarding FOR INSERT TO aval_app
  WITH CHECK (
    organization_id = aval_private.current_organization_id()
    AND user_id = aval_private.current_principal_id()
    AND aval_private.has_org_access(organization_id)
  );
DROP POLICY IF EXISTS user_onboarding_update ON public.user_onboarding;
CREATE POLICY user_onboarding_update ON public.user_onboarding FOR UPDATE TO aval_app
  USING (user_id = aval_private.current_principal_id() AND aval_private.has_org_access(organization_id))
  WITH CHECK (user_id = aval_private.current_principal_id() AND aval_private.has_org_access(organization_id));
DROP POLICY IF EXISTS user_onboarding_delete ON public.user_onboarding;

REVOKE ALL ON FUNCTION aval_private.can_decide_approval(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aval_private.can_decide_approval(text, text) TO aval_app;
