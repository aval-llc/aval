-- A NOBYPASSRLS role for cron and verified provider callbacks. It may operate
-- only inside the organization selected in transaction-local context.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aval_worker') THEN
    CREATE ROLE aval_worker NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT aval_worker TO postgres;
GRANT USAGE ON SCHEMA public TO aval_worker;
GRANT USAGE ON SCHEMA aval_private TO aval_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aval_worker;

DO $$
DECLARE table_row record;
DECLARE table_policy text;
BEGIN
  FOR table_row IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'organization_id'
  LOOP
    table_policy := table_row.table_name || '_worker_all';
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_policy, table_row.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO aval_worker USING (organization_id = aval_private.current_organization_id()) WITH CHECK (organization_id = aval_private.current_organization_id())',
      table_policy,
      table_row.table_name
    );
  END LOOP;
END $$;

DROP POLICY IF EXISTS organizations_worker_select ON public.organizations;
CREATE POLICY organizations_worker_select ON public.organizations FOR SELECT TO aval_worker
  USING (id = aval_private.current_organization_id());

DROP POLICY IF EXISTS messages_worker_all ON public.messages;
CREATE POLICY messages_worker_all ON public.messages FOR ALL TO aval_worker
  USING (EXISTS (
    SELECT 1 FROM public.conversations conversation
    WHERE conversation.id = messages.conversation_id
      AND conversation.organization_id = aval_private.current_organization_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.conversations conversation
    WHERE conversation.id = messages.conversation_id
      AND conversation.organization_id = aval_private.current_organization_id()
  ));

DROP POLICY IF EXISTS automation_steps_worker_all ON public.automation_steps;
CREATE POLICY automation_steps_worker_all ON public.automation_steps FOR ALL TO aval_worker
  USING (EXISTS (
    SELECT 1 FROM public.automation_runs run
    WHERE run.id = automation_steps.run_id
      AND run.organization_id = aval_private.current_organization_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.automation_runs run
    WHERE run.id = automation_steps.run_id
      AND run.organization_id = aval_private.current_organization_id()
  ));

CREATE OR REPLACE FUNCTION aval_private.due_worker_organizations(maximum integer DEFAULT 100)
RETURNS TABLE(organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT candidate.organization_id
  FROM (
    SELECT task.organization_id
    FROM public.agent_tasks task
    WHERE task.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
    UNION
    SELECT state.organization_id
    FROM public.integration_sync_state state
    WHERE state.enabled
    UNION
    SELECT source.organization_id
    FROM public.communication_poll_sources source
    WHERE source.enabled
    UNION
    SELECT operation.organization_id
    FROM public.agent_financial_operations operation
    WHERE operation.status = 'unknown'
  ) candidate
  ORDER BY candidate.organization_id
  LIMIT greatest(1, least(maximum, 500))
$$;

CREATE OR REPLACE FUNCTION aval_private.webhook_connection(
  provider_name text,
  connection_identifier text DEFAULT NULL,
  external_account_key text DEFAULT NULL
) RETURNS TABLE(organization_id text, connection_id text, encrypted_credentials text, external_account_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT connection.organization_id, connection.id, connection.access_token_ciphertext, connection.external_account_id
  FROM public.integration_connections connection
  WHERE connection.provider = provider_name
    AND connection.status = 'connected'
    AND (
      (connection_identifier IS NOT NULL AND connection.id = connection_identifier)
      OR (connection_identifier IS NULL AND external_account_key IS NOT NULL AND connection.external_account_id = external_account_key)
    )
  ORDER BY connection.id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION aval_private.delivery_connection(operation_identifier text)
RETURNS TABLE(organization_id text, delivery_id text, connection_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT delivery.organization_id, delivery.id, delivery.connection_id
  FROM public.communication_deliveries delivery
  WHERE delivery.id = operation_identifier
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION aval_private.stripe_subscription_organization(subscription_identifier text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT subscription.organization_id
  FROM public.subscriptions subscription
  WHERE subscription.stripe_subscription_id = subscription_identifier
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION aval_private.due_worker_organizations(integer) FROM PUBLIC, aval_app;
REVOKE ALL ON FUNCTION aval_private.webhook_connection(text, text, text) FROM PUBLIC, aval_app;
REVOKE ALL ON FUNCTION aval_private.delivery_connection(text) FROM PUBLIC, aval_app;
REVOKE ALL ON FUNCTION aval_private.stripe_subscription_organization(text) FROM PUBLIC, aval_app;
GRANT EXECUTE ON FUNCTION aval_private.due_worker_organizations(integer) TO aval_worker;
GRANT EXECUTE ON FUNCTION aval_private.webhook_connection(text, text, text) TO aval_worker;
GRANT EXECUTE ON FUNCTION aval_private.delivery_connection(text) TO aval_worker;
GRANT EXECUTE ON FUNCTION aval_private.stripe_subscription_organization(text) TO aval_worker;
