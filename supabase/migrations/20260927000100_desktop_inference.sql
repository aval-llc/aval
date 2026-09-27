CREATE TABLE public.desktop_model_runners (
  organization_id text PRIMARY KEY REFERENCES public.organizations(id),
  user_id text NOT NULL,
  runner_id text NOT NULL,
  model text NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  token_limit bigint NOT NULL DEFAULT 500000 CHECK (token_limit > 0),
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  tokens_reserved bigint NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0)
);
ALTER TABLE public.agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_status_check;
ALTER TABLE public.agent_tasks ADD CONSTRAINT agent_tasks_status_check CHECK(status IN (
 'QUEUED','RUNNING','WAITING_FOR_MODEL','WAITING_FOR_TOOL','WAITING_FOR_APPROVAL','PENDING_VERIFICATION','WAITING_FOR_HUMAN',
 'WAITING_FOR_PROVIDER','WAITING_FOR_RESIDENT','WAITING_FOR_OWNER','WAITING_FOR_VENDOR','WAITING_FOR_APPLICANT','WAITING_FOR_DOCUMENT',
 'WAITING_FOR_AGENT','SCHEDULED','BLOCKED','COMPLETED','FAILED','CANCELLED','SUPERSEDED')) NOT VALID;

-- One demo workspace per authenticated person. No caller-supplied owner or target.
CREATE OR REPLACE FUNCTION aval_private.create_demo_workspace() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p text := aval_private.current_principal_id(); o text;
BEGIN
 IF p IS NULL OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=p) THEN RAISE EXCEPTION 'Authentication required'; END IF;
 o := 'org_demo_' || substr(md5(p),1,24);
 INSERT INTO public.organizations(id,name,owner_user_id,active_model_provider,created_at,updated_at)
 VALUES(o,'Aval Demo',p,'desktop_codex',now(),now()) ON CONFLICT(id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=o AND owner_user_id=p) THEN RAISE EXCEPTION 'Workspace ownership mismatch'; END IF;
 INSERT INTO public.organization_members(id,organization_id,user_id,role,created_at,updated_at)
 VALUES('membership_'||o||'_'||p,o,p,'owner',now(),now()) ON CONFLICT(organization_id,user_id) DO NOTHING;
 INSERT INTO public.access_grants(id,organization_id,principal_id,role,organization_scope,capabilities_json,created_by_principal_id,created_at,updated_at)
 VALUES('grant_'||o||'_'||p,o,p,'org_admin',true,'[]'::jsonb,p,now(),now()) ON CONFLICT(organization_id,id) DO NOTHING;
 RETURN o;
END $$;
REVOKE ALL ON FUNCTION aval_private.create_demo_workspace() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aval_private.create_demo_workspace() TO aval_app;
CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_org_id_uq ON public.agent_tasks(organization_id,id);
CREATE TABLE public.desktop_model_jobs (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organizations(id),
  task_id text NOT NULL,
  request_key text NOT NULL,
  request_json jsonb NOT NULL,
  response_json jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','completed','cancelled')),
  claim_token text,
  runner_id text,
  model text,
  reserved_tokens bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, task_id, request_key),
  FOREIGN KEY(organization_id,task_id) REFERENCES public.agent_tasks(organization_id,id)
);
CREATE INDEX desktop_model_jobs_pending ON public.desktop_model_jobs(organization_id,status,created_at);
ALTER TABLE public.desktop_model_runners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desktop_model_runners FORCE ROW LEVEL SECURITY;
ALTER TABLE public.desktop_model_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desktop_model_jobs FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.desktop_model_runners, public.desktop_model_jobs TO aval_app, aval_worker;
CREATE POLICY desktop_runners_owner ON public.desktop_model_runners FOR ALL TO aval_app
 USING (aval_private.has_org_role(organization_id,ARRAY['org_admin']))
 WITH CHECK (aval_private.has_org_role(organization_id,ARRAY['org_admin']));
CREATE POLICY desktop_jobs_owner ON public.desktop_model_jobs FOR ALL TO aval_app
 USING (aval_private.has_org_role(organization_id,ARRAY['org_admin']))
 WITH CHECK (aval_private.has_org_role(organization_id,ARRAY['org_admin']));
CREATE POLICY desktop_jobs_actor_read ON public.desktop_model_jobs FOR SELECT TO aval_app
 USING (EXISTS(SELECT 1 FROM public.agent_tasks t WHERE t.id=task_id AND t.organization_id=desktop_model_jobs.organization_id AND t.user_id=aval_private.current_principal_id()));
CREATE POLICY desktop_jobs_actor_enqueue ON public.desktop_model_jobs FOR INSERT TO aval_app
 WITH CHECK (status='pending' AND response_json IS NULL AND claim_token IS NULL AND runner_id IS NULL AND model IS NULL AND reserved_tokens=0 AND
 EXISTS(SELECT 1 FROM public.agent_tasks t WHERE t.id=task_id AND t.organization_id=desktop_model_jobs.organization_id AND t.user_id=aval_private.current_principal_id()));
CREATE POLICY desktop_runners_worker ON public.desktop_model_runners FOR ALL TO aval_worker
 USING (organization_id=nullif(current_setting('aval.organization_id',true),''))
 WITH CHECK (organization_id=nullif(current_setting('aval.organization_id',true),''));
CREATE POLICY desktop_jobs_worker ON public.desktop_model_jobs FOR ALL TO aval_worker
 USING (organization_id=nullif(current_setting('aval.organization_id',true),''))
 WITH CHECK (organization_id=nullif(current_setting('aval.organization_id',true),''));

CREATE TABLE public.pms_report_profiles (
 organization_id text NOT NULL REFERENCES public.organizations(id),
 provider text NOT NULL CHECK(provider IN ('appfolio','yardi')),
 dataset text NOT NULL,
 mapping_json jsonb NOT NULL,
 last_import_at timestamptz NOT NULL,
 record_count integer NOT NULL CHECK(record_count>=0),
 PRIMARY KEY(organization_id,provider,dataset)
);
ALTER TABLE public.pms_report_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pms_report_profiles FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.pms_report_profiles TO aval_app;
CREATE POLICY pms_report_profiles_owner ON public.pms_report_profiles FOR ALL TO aval_app
 USING(aval_private.has_org_role(organization_id,ARRAY['org_admin']))
 WITH CHECK(aval_private.has_org_role(organization_id,ARRAY['org_admin']));
GRANT SELECT ON public.pms_report_profiles TO aval_worker;
CREATE POLICY pms_report_profiles_worker_read ON public.pms_report_profiles FOR SELECT TO aval_worker
 USING(organization_id=nullif(current_setting('aval.organization_id',true),''));
