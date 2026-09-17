CREATE TABLE public.communication_inbox_state (
  connection_id text PRIMARY KEY REFERENCES public.integration_connections(id),
  organization_id text NOT NULL REFERENCES public.organizations(id),
  account_id text NOT NULL,
  cursor_json jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.inbound_pending (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organizations(id),
  conversation_id text NOT NULL REFERENCES public.conversations(id),
  external_message_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','onboarding_required','rate_limited','review_required','filtered','queued')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, conversation_id, external_message_id)
);
CREATE INDEX inbound_pending_status_idx ON public.inbound_pending(organization_id, status, created_at);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['communication_inbox_state','inbound_pending'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO aval_app, aval_worker', t);
    EXECUTE format('CREATE POLICY tenant_read ON public.%I FOR SELECT TO aval_app USING (aval_private.has_org_access(organization_id))', t);
    EXECUTE format('CREATE POLICY admin_write ON public.%I FOR ALL TO aval_app USING (aval_private.has_org_role(organization_id, ARRAY[''org_admin''])) WITH CHECK (aval_private.has_org_role(organization_id, ARRAY[''org_admin'']))', t);
    EXECUTE format('CREATE POLICY worker_scope ON public.%I FOR ALL TO aval_worker USING (organization_id = aval_private.current_organization_id()) WITH CHECK (organization_id = aval_private.current_organization_id())', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION aval_private.due_worker_organizations(maximum integer DEFAULT 100)
RETURNS TABLE(organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT candidate.organization_id FROM (
    SELECT task.organization_id FROM public.agent_tasks task WHERE task.status NOT IN ('COMPLETED','FAILED','CANCELLED')
    UNION SELECT state.organization_id FROM public.integration_sync_state state WHERE state.enabled
    UNION SELECT source.organization_id FROM public.communication_poll_sources source WHERE source.enabled
    UNION SELECT operation.organization_id FROM public.agent_financial_operations operation WHERE operation.status = 'unknown'
    UNION SELECT pending.organization_id FROM public.inbound_pending pending WHERE pending.status IN ('pending','onboarding_required','rate_limited')
  ) candidate ORDER BY candidate.organization_id LIMIT greatest(1, least(maximum, 500))
$$;
