-- A closed Desktop must not prevent an uncertain submission reaching a human.
CREATE OR REPLACE FUNCTION aval_private.due_worker_organizations(maximum integer DEFAULT 100)
RETURNS TABLE(organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT candidate.organization_id FROM (
    SELECT task.organization_id FROM public.agent_tasks task WHERE task.status NOT IN ('COMPLETED','FAILED','CANCELLED')
    UNION SELECT state.organization_id FROM public.integration_sync_state state WHERE state.enabled
    UNION SELECT source.organization_id FROM public.communication_poll_sources source WHERE source.enabled
    UNION SELECT operation.organization_id FROM public.agent_financial_operations operation WHERE operation.status = 'unknown'
    UNION SELECT pending.organization_id FROM public.inbound_pending pending WHERE pending.status IN ('pending','onboarding_required','rate_limited')
    UNION SELECT queue.organization_id FROM public.pms_write_queue queue
      WHERE queue.protocol_json IS NOT NULL AND queue.status IN ('pending','leased','submission_unknown','verifying')
  ) candidate ORDER BY candidate.organization_id LIMIT greatest(1, least(maximum, 500))
$$;
