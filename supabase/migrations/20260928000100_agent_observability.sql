-- Append-only task evidence owns the manifest. Delivery is a separate projection.
ALTER TABLE public.agent_task_steps ADD COLUMN execution_manifest_json jsonb;
ALTER TABLE public.desktop_model_jobs ADD COLUMN execution_manifest_json jsonb;
CREATE TABLE public.agent_trace_deliveries (
  organization_id text NOT NULL REFERENCES public.organizations(id),
  step_id text NOT NULL REFERENCES public.agent_task_steps(id),
  project_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_status integer,
  PRIMARY KEY (organization_id, step_id, project_id)
);
ALTER TABLE public.agent_trace_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_trace_deliveries FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.agent_trace_deliveries TO aval_worker;
CREATE POLICY trace_delivery_worker ON public.agent_trace_deliveries FOR ALL TO aval_worker
  USING (organization_id=aval_private.current_organization_id())
  WITH CHECK (organization_id=aval_private.current_organization_id() AND EXISTS(
    SELECT 1 FROM public.agent_task_steps s WHERE s.id=step_id AND s.organization_id=agent_trace_deliveries.organization_id));
GRANT SELECT ON public.agent_trace_deliveries TO aval_app;
CREATE POLICY trace_delivery_owner_read ON public.agent_trace_deliveries FOR SELECT TO aval_app
  USING (aval_private.has_org_role(organization_id,ARRAY['org_admin']));
