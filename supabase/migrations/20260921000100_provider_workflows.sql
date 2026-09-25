-- Provider workflows Aval owns, with a lifecycle and enough metadata to run.
--
-- `pms_action_flows` held steps, a digest and three statuses, and every row
-- belonged to one workspace. That is the customer-recorded model, and it left
-- two holes. A workflow could not become active without a direct database
-- write, because nothing authored one. And driving AppFolio's work-order screen
-- was framed as something each customer discovers for themselves, when it is
-- Aval's problem to solve once.
--
-- `organization_id` is now nullable, and null means a workflow Aval ships. The
-- same shape as `expertise_profiles`, for the same reason. A workspace may
-- still hold its own version of a (provider, action) and `activeFlow` prefers
-- it, which serves a customer with a non-standard configuration without forking
-- the shipped one.
--
-- Shipped workflows are seeded by migration and are read-only at runtime. That
-- is what "only authorized administrators or developers may promote a workflow"
-- means here: promoting a shipped workflow is a deployment, and promoting a
-- workspace's own is an act by one of its administrators.

ALTER TABLE public.pms_action_flows ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE public.pms_action_flows
  ADD COLUMN IF NOT EXISTS access_mode             text NOT NULL DEFAULT 'customer_desktop_session',
  ADD COLUMN IF NOT EXISTS required_role           text,
  ADD COLUMN IF NOT EXISTS risk_class              text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS verification_strategy   text NOT NULL DEFAULT 'read_after_write',
  ADD COLUMN IF NOT EXISTS reconciliation_strategy text NOT NULL DEFAULT 'field_match',
  ADD COLUMN IF NOT EXISTS fallback                text NOT NULL DEFAULT 'human_handoff',
  ADD COLUMN IF NOT EXISTS certification           text NOT NULL DEFAULT 'unimplemented',
  ADD COLUMN IF NOT EXISTS promoted_by_user_id     text,
  ADD COLUMN IF NOT EXISTS promoted_at             timestamptz,
  ADD COLUMN IF NOT EXISTS known_issues            text;

-- The lifecycle the directive asks for. `candidate` was the old name for a
-- thing not yet in service and `retired` for one taken out of it; both map
-- onto the new vocabulary without losing which was which.
UPDATE public.pms_action_flows SET status = 'draft'    WHERE status = 'candidate';
UPDATE public.pms_action_flows SET status = 'disabled' WHERE status = 'retired';

ALTER TABLE public.pms_action_flows DROP CONSTRAINT IF EXISTS pms_action_flows_status;
ALTER TABLE public.pms_action_flows ADD CONSTRAINT pms_action_flows_status
  CHECK (status IN ('draft','testing','active','degraded','disabled'));

ALTER TABLE public.pms_action_flows DROP CONSTRAINT IF EXISTS pms_action_flows_certification;
ALTER TABLE public.pms_action_flows ADD CONSTRAINT pms_action_flows_certification
  CHECK (certification IN (
    'unimplemented','unit_tested','simulator_e2e_tested',
    'customer_authorized_ui_tested','sandbox_tested','live_provider_tested'));

ALTER TABLE public.pms_action_flows DROP CONSTRAINT IF EXISTS pms_action_flows_risk;
ALTER TABLE public.pms_action_flows ADD CONSTRAINT pms_action_flows_risk
  CHECK (risk_class IN ('low','medium','high','critical'));

-- A promoted row has an author. Activation without one is the state this
-- column exists to make impossible to reach quietly.
ALTER TABLE public.pms_action_flows DROP CONSTRAINT IF EXISTS pms_action_flows_promotion;
ALTER TABLE public.pms_action_flows ADD CONSTRAINT pms_action_flows_promotion
  CHECK (status <> 'active' OR promoted_by_user_id IS NOT NULL);

-- NULLs are distinct in a unique index, so the existing one would let two
-- shipped v1 rows exist for the same provider and action. Split in two: one
-- for workspace rows, one for shipped ones.
DROP INDEX IF EXISTS pms_action_flow_uq;
CREATE UNIQUE INDEX IF NOT EXISTS pms_action_flow_org_uq
  ON public.pms_action_flows (organization_id, provider, action, version)
  WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pms_action_flow_shipped_uq
  ON public.pms_action_flows (provider, action, version)
  WHERE organization_id IS NULL;

-- Reading a shipped workflow is not reading another tenant's data; it is
-- reading Aval's. Writes stay workspace-scoped, so nothing at runtime can
-- author or alter a shipped one.
DROP POLICY IF EXISTS "pms_action_flows_select" ON public."pms_action_flows";
CREATE POLICY "pms_action_flows_select" ON public."pms_action_flows"
  FOR SELECT TO aval_app
  USING (organization_id IS NULL OR aval_private.has_org_access(organization_id));

DROP POLICY IF EXISTS "pms_action_flows_insert" ON public."pms_action_flows";
CREATE POLICY "pms_action_flows_insert" ON public."pms_action_flows"
  FOR INSERT TO aval_app
  WITH CHECK (organization_id IS NOT NULL
              AND aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));

DROP POLICY IF EXISTS "pms_action_flows_update" ON public."pms_action_flows";
CREATE POLICY "pms_action_flows_update" ON public."pms_action_flows"
  FOR UPDATE TO aval_app
  USING (organization_id IS NOT NULL
         AND aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']))
  WITH CHECK (organization_id IS NOT NULL
              AND aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));

DROP POLICY IF EXISTS "pms_action_flows_worker_all" ON public."pms_action_flows";
CREATE POLICY "pms_action_flows_worker_all" ON public."pms_action_flows"
  FOR ALL TO aval_worker
  USING (organization_id IS NULL OR organization_id = aval_private.current_organization_id())
  WITH CHECK (organization_id = aval_private.current_organization_id());

-- The first workflow Aval ships: AppFolio's work-order screen, driven as the
-- customer's own signed-in user.
--
-- Its certification says what has actually been proven and nothing more. It has
-- been replayed end to end against a simulator that keeps its own state; it has
-- never touched AppFolio. `simulator_e2e_tested` is the honest ceiling until an
-- authorized customer account exercises it, and `known_issues` says so rather
-- than leaving a reader to infer it. It ships as a draft for the same reason.
INSERT INTO public.pms_action_flows (
  id, organization_id, provider, action, version, access_mode,
  steps_json, digest, status, required_role, risk_class,
  verification_strategy, reconciliation_strategy, fallback, certification,
  promoted_by_user_id, promoted_at, consecutive_failures, known_issues,
  created_at, updated_at
) VALUES (
  'flow_appfolio_work_order_create_v1',
  NULL,
  'appfolio',
  'maintenance.work_order.create',
  1,
  'customer_desktop_session',
  '[{"kind":"open","page":"Maintenance"},{"kind":"click","button":"New Work Order"},{"kind":"fill","label":"Unit","from":"unit"},{"kind":"fill","label":"Description","from":"description"},{"kind":"click","button":"Create Work Order"},{"kind":"capture","label":"Work Order #","as":"externalId"}]',
  -- Replaced with the real digest by `reseal` on first read; a seeded row that
  -- claimed a digest it had not computed would verify against nothing.
  'seeded',
  'draft',
  'A PMS user who can create maintenance work orders.',
  'medium',
  'read_after_write',
  'field_match',
  'human_handoff',
  'simulator_e2e_tested',
  NULL,
  NULL,
  0,
  'Page and field labels are taken from the simulator, not from AppFolio. They must be confirmed against a real authorized session before this leaves draft.',
  now(),
  now()
) ON CONFLICT (id) DO NOTHING;
