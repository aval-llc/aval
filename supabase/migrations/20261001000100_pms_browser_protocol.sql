-- Browser protocol 2. Historical sessions and writes are never assigned an
-- account identity by inference. The old HTTP runner is retired with this build.
ALTER TABLE public.pms_write_queue
  ADD COLUMN connection_id text REFERENCES public.integration_connections(id),
  ADD COLUMN protocol_json jsonb,
  ADD COLUMN lease_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN verify_after timestamptz,
  ADD COLUMN review_due_at timestamptz,
  ADD COLUMN responsible_user_id text,
  ADD COLUMN verification_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN external_id text;
ALTER TABLE public.pms_action_flows ADD COLUMN connection_id text REFERENCES public.integration_connections(id);

CREATE TABLE public.pms_browser_devices (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organizations(id),
  user_id text NOT NULL,
  token_hash text NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.pms_browser_bindings (
  id text PRIMARY KEY REFERENCES public.integration_connections(id),
  organization_id text NOT NULL REFERENCES public.organizations(id),
  device_id text NOT NULL REFERENCES public.pms_browser_devices(id),
  provider text NOT NULL,
  identity_json jsonb NOT NULL,
  feasibility_json jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.pms_browser_reports (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organizations(id),
  queue_id text NOT NULL REFERENCES public.pms_write_queue(id),
  device_id text NOT NULL REFERENCES public.pms_browser_devices(id),
  lease_generation integer NOT NULL,
  report_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pms_browser_reports_queue ON public.pms_browser_reports(organization_id,queue_id,created_at);
CREATE INDEX pms_browser_connection_queue ON public.pms_write_queue(organization_id,connection_id,status);

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['pms_browser_devices','pms_browser_bindings','pms_browser_reports'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.%I TO aval_app,aval_worker',relation);
    EXECUTE format('CREATE POLICY browser_owner ON public.%I FOR ALL TO aval_app USING (organization_id=aval_private.current_organization_id() AND aval_private.has_org_role(organization_id,ARRAY[''org_admin''])) WITH CHECK (organization_id=aval_private.current_organization_id() AND aval_private.has_org_role(organization_id,ARRAY[''org_admin'']))',relation);
    EXECUTE format('CREATE POLICY browser_worker ON public.%I FOR ALL TO aval_worker USING (organization_id=aval_private.current_organization_id()) WITH CHECK (organization_id=aval_private.current_organization_id())',relation);
  END LOOP;
END $$;
REVOKE UPDATE ON public.pms_browser_reports FROM aval_app,aval_worker;

-- Previously queued work has neither a verified connection nor a commit grant.
UPDATE public.pms_write_queue SET status='needs_review',
  last_error='Reconnect a restricted PMS staff account and request a new approval.',
  leased_by=NULL,lease_expires_at=NULL,review_due_at=now()
WHERE status IN ('pending','leased');

CREATE FUNCTION aval_private.preserve_pms_submission() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  IF OLD.submitted_at IS NOT NULL AND
    (NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR
     NEW.status IN ('pending','leased') OR
     NEW.connection_id IS DISTINCT FROM OLD.connection_id OR
     NEW.protocol_json IS DISTINCT FROM OLD.protocol_json OR
     NEW.payload_json IS DISTINCT FROM OLD.payload_json) THEN
    RAISE EXCEPTION 'A possible PMS submission may only be reconciled';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_pms_submission BEFORE UPDATE ON public.pms_write_queue
FOR EACH ROW EXECUTE FUNCTION aval_private.preserve_pms_submission();
