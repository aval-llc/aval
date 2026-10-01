-- A monitor receives counts/timestamps only, never unrestricted tenant rows.
CREATE FUNCTION aval_private.agent_health_snapshot() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'lastWorkerCompletedAt', (SELECT max(finished_at) FROM public.agent_worker_runs WHERE status='completed'),
    'oldestQueuedAt', (SELECT min(created_at) FROM public.agent_tasks WHERE status IN ('QUEUED','WAITING_FOR_TOOL')),
    'expiredRunningLeases', (SELECT count(*) FROM public.agent_tasks WHERE status='RUNNING' AND lease_expires_at < now()),
    'failedTasks24h', (SELECT count(*) FROM public.agent_tasks WHERE status='FAILED' AND finished_at >= now()-interval '24 hours'),
    'pendingApprovals', (SELECT count(*) FROM public.agent_approvals WHERE status='pending'),
    'reconciliationDiscrepancies', (SELECT count(*) FROM public.agent_financial_operations WHERE reconciliation_status IN ('mismatch','manual_review')),
    'reconciliationOverdue', (SELECT count(*) FROM public.agent_financial_operations WHERE reconciliation_status <> 'matched' AND next_reconcile_at < now()-interval '10 minutes')
  )
$$;
REVOKE ALL ON FUNCTION aval_private.agent_health_snapshot() FROM PUBLIC, aval_app;
GRANT EXECUTE ON FUNCTION aval_private.agent_health_snapshot() TO aval_worker;
