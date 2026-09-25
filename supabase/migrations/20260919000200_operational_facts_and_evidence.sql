-- Operational fact provenance/freshness, and evidence for external effects.
--
-- The operational tables already record which provider a row came from. They do
-- not record when the provider considered it true, when Aval last looked,
-- whether it is authoritative or inferred, or that another system disagrees.
-- `operational_facts` holds that, one row per (entity, field, source), so a
-- second source produces a second row rather than overwriting the first.
--
-- `action_evidence` is what lets PENDING_VERIFICATION end in proof rather than
-- in budget exhaustion.

CREATE TABLE IF NOT EXISTS public.operational_facts (
  id                text        PRIMARY KEY,
  organization_id   text        NOT NULL REFERENCES public.organizations(id),
  entity_type       text        NOT NULL,
  entity_id         text        NOT NULL,
  fact_type         text        NOT NULL,
  value             text,
  value_ref         text,
  source_type       text        NOT NULL,
  source_provider   text,
  source_record_id  text,
  observed_at       timestamptz,
  synced_at         timestamptz NOT NULL,
  expires_at        timestamptz,
  freshness_policy  text,
  authoritativeness text        NOT NULL,
  confidence        double precision,
  derived_from_json jsonb       NOT NULL DEFAULT '[]'::jsonb,
  conflict_state    text        NOT NULL DEFAULT 'none',
  superseded_by     text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  CONSTRAINT operational_facts_source_type CHECK (source_type IN ('provider','aval_native','human','document','inference')),
  CONSTRAINT operational_facts_authority CHECK (authoritativeness IN ('authoritative','reported','inferred','human_confirmed')),
  CONSTRAINT operational_facts_conflict_state CHECK (conflict_state IN ('none','conflicted','superseded')),
  CONSTRAINT operational_facts_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- An inference must say how sure it is; nothing else may pretend to.
  CONSTRAINT operational_facts_confidence_scope CHECK ((source_type = 'inference') = (confidence IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS operational_facts_entity_idx
  ON public.operational_facts (organization_id, entity_type, entity_id, fact_type);
CREATE INDEX IF NOT EXISTS operational_facts_conflict_idx
  ON public.operational_facts (organization_id, conflict_state);
-- One live fact per (entity, field, source). `source_provider` is nullable and
-- NULLS NOT DISTINCT keeps two aval_native facts for one field from coexisting.
CREATE UNIQUE INDEX IF NOT EXISTS operational_facts_source_uq
  ON public.operational_facts (organization_id, entity_type, entity_id, fact_type, source_type, source_provider)
  NULLS NOT DISTINCT;

CREATE TABLE IF NOT EXISTS public.action_evidence (
  id                   text        PRIMARY KEY,
  organization_id      text        NOT NULL REFERENCES public.organizations(id),
  task_id              text        NOT NULL REFERENCES public.agent_tasks(id),
  action_execution_id  text        NOT NULL,
  tool_name            text        NOT NULL,
  claim                text        NOT NULL,
  expected_state_json  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  evidence_type        text        NOT NULL,
  source_provider      text,
  external_record_id   text,
  observed_state_json  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  observed_at          timestamptz,
  verification_result  text        NOT NULL,
  payload_ref          text,
  created_at           timestamptz NOT NULL,
  CONSTRAINT action_evidence_type CHECK (evidence_type IN ('provider_reread','provider_event','human_confirmation','document','aval_native')),
  CONSTRAINT action_evidence_result CHECK (verification_result IN ('confirmed','contradicted','inconclusive'))
);

CREATE INDEX IF NOT EXISTS action_evidence_task_idx ON public.action_evidence (organization_id, task_id);
CREATE INDEX IF NOT EXISTS action_evidence_execution_idx ON public.action_evidence (action_execution_id);
-- A provider can deliver the same webhook twice and a scheduled re-read can
-- race one. The same observation of the same execution is one row.
CREATE UNIQUE INDEX IF NOT EXISTS action_evidence_observation_uq
  ON public.action_evidence (action_execution_id, evidence_type, external_record_id, verification_result)
  NULLS NOT DISTINCT;

-- Tenant tables: default deny, read for anyone with organization access, write
-- for the roles that operate it. Evidence and facts are append-and-correct
-- records, so DELETE is granted to no application role.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['operational_facts','action_evidence'] LOOP
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO aval_app, aval_worker', t);
  END LOOP;
END $$;
