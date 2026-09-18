-- Isolated PHASE ZERO fixture schema. This is NOT the 59-table application port.
-- Apply only to local Supabase or a dedicated benchmark project.
BEGIN;
CREATE SCHEMA aval_benchmark;
REVOKE ALL ON SCHEMA aval_benchmark FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aval_benchmark_app') THEN
    CREATE ROLE aval_benchmark_app NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aval_benchmark_app' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Existing benchmark role has unsafe privileges';
  END IF;
END $$;

CREATE TABLE aval_benchmark.organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  audit_sequence bigint NOT NULL DEFAULT 0,
  audit_hash text NOT NULL DEFAULT 'GENESIS'
);
CREATE TABLE aval_benchmark.members (
  organization_id text NOT NULL REFERENCES aval_benchmark.organizations(id),
  principal_id text NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (organization_id, principal_id)
);
CREATE TABLE aval_benchmark.properties (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES aval_benchmark.organizations(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  external_id text NOT NULL,
  acquisition_cost_cents bigint NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, external_id)
);
CREATE INDEX properties_list ON aval_benchmark.properties (organization_id, status, id);
CREATE TABLE aval_benchmark.agent_tasks (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES aval_benchmark.organizations(id),
  property_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  lease_generation bigint NOT NULL DEFAULT 0,
  step_count integer NOT NULL DEFAULT 0,
  FOREIGN KEY (organization_id, property_id) REFERENCES aval_benchmark.properties(organization_id, id)
);
CREATE INDEX tasks_claim ON aval_benchmark.agent_tasks (organization_id, next_run_at, id)
  WHERE status IN ('queued', 'running');
CREATE TABLE aval_benchmark.answer_audit_log (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES aval_benchmark.organizations(id),
  sequence bigint NOT NULL,
  previous_hash text NOT NULL,
  entry_hash text NOT NULL,
  payload_digest text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sequence),
  UNIQUE (organization_id, request_id)
);
CREATE FUNCTION aval_benchmark.reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'append-only audit' USING ERRCODE = '23514'; END;
$$;
REVOKE ALL ON FUNCTION aval_benchmark.reject_audit_mutation() FROM PUBLIC;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON aval_benchmark.answer_audit_log
FOR EACH ROW EXECUTE FUNCTION aval_benchmark.reject_audit_mutation();

ALTER TABLE aval_benchmark.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE aval_benchmark.members FORCE ROW LEVEL SECURITY;
CREATE POLICY own_membership ON aval_benchmark.members FOR SELECT TO aval_benchmark_app USING (
  principal_id = nullif(current_setting('aval.principal_id', true), '')
  AND organization_id = nullif(current_setting('aval.organization_id', true), '')
  AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
);
CREATE FUNCTION aval_benchmark.can_access(org text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT org = nullif(current_setting('aval.organization_id', true), '')
    AND EXISTS (SELECT 1 FROM aval_benchmark.members WHERE organization_id = org);
$$;
REVOKE ALL ON FUNCTION aval_benchmark.can_access(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aval_benchmark.can_access(text) TO aval_benchmark_app;

ALTER TABLE aval_benchmark.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE aval_benchmark.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON aval_benchmark.organizations TO aval_benchmark_app
  USING (aval_benchmark.can_access(id)) WITH CHECK (aval_benchmark.can_access(id));
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['properties', 'agent_tasks', 'answer_audit_log'] LOOP
    EXECUTE format('ALTER TABLE aval_benchmark.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE aval_benchmark.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant ON aval_benchmark.%I TO aval_benchmark_app USING (aval_benchmark.can_access(organization_id)) WITH CHECK (aval_benchmark.can_access(organization_id))', tbl);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA aval_benchmark TO aval_benchmark_app;
GRANT SELECT ON ALL TABLES IN SCHEMA aval_benchmark TO aval_benchmark_app;
GRANT UPDATE (audit_sequence, audit_hash) ON aval_benchmark.organizations TO aval_benchmark_app;
GRANT UPDATE (revision, updated_at) ON aval_benchmark.properties TO aval_benchmark_app;
GRANT UPDATE (status, lease_owner, lease_expires_at, lease_generation, step_count) ON aval_benchmark.agent_tasks TO aval_benchmark_app;
GRANT INSERT ON aval_benchmark.answer_audit_log TO aval_benchmark_app;

-- Keep fixture identity as text, including intentionally non-UUID external IDs.
INSERT INTO aval_benchmark.organizations(id, name)
SELECT 'bench_org_' || n, 'Synthetic organization ' || n FROM generate_series(0,9) AS n;
INSERT INTO aval_benchmark.members(organization_id, principal_id)
SELECT id, 'principal_' || id FROM aval_benchmark.organizations;
INSERT INTO aval_benchmark.properties(id, organization_id, name, external_id, acquisition_cost_cents, attributes)
SELECT o.id || '_property_' || lpad(n::text, 5, '0'), o.id, 'Synthetic property ' || n,
  'external/' || n, 100000001, jsonb_build_object('units', 100, 'source', 'synthetic')
FROM aval_benchmark.organizations o CROSS JOIN generate_series(1,1000) AS n;
INSERT INTO aval_benchmark.agent_tasks(id, organization_id, property_id)
SELECT id || '_task', organization_id, id FROM aval_benchmark.properties;
ANALYZE aval_benchmark.properties;
ANALYZE aval_benchmark.agent_tasks;
COMMIT;
