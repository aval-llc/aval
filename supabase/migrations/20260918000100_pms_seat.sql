-- The PMS seat: agent mailboxes, the write path, and the learned-flow store.
--
-- A separate migration rather than an addition to 20260910000100, because that
-- baseline is already applied to production and apply-supabase-migrations.mjs
-- protects applied migrations by hash — editing it fails the deploy instead of
-- installing anything. Everything the seat needs is therefore here, including
-- its row-level security, which the frozen 20260910000200 cannot carry either.

CREATE TABLE "agent_deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"provider" text NOT NULL,
	"workflows_json" jsonb DEFAULT '[]' NOT NULL,
	"autonomy_mode" text DEFAULT 'supervised' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
CREATE TABLE "organization_seat_slugs" (
	"slug" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
CREATE TABLE "pms_action_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"action" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"steps_json" jsonb NOT NULL,
	"digest" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"learned_by_user_id" text,
	"last_replay_at" timestamp with time zone,
	"last_replay_ok" boolean,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
CREATE TABLE "pms_seat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"recipient" text NOT NULL,
	"organization_id" text,
	"disposition" text NOT NULL,
	"authenticated_domain" text,
	"method" text,
	"provider_id" text,
	"reason" text,
	"observed_authserv_ids" text,
	"object_key" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone NOT NULL
);
CREATE TABLE "pms_seat_senders" (
	"organization_id" text NOT NULL,
	"domain" text NOT NULL,
	"provider_id" text NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL
);
CREATE TABLE "pms_write_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"signed_authorization" boolean DEFAULT false NOT NULL,
	"authorization_reference" text,
	"version" integer DEFAULT 1 NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
CREATE TABLE "pms_write_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"action" text NOT NULL,
	"approval_id" text,
	"flow_id" text,
	"payload_json" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"leased_by" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "organization_seat_slugs" ADD CONSTRAINT "organization_seat_slugs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pms_action_flows" ADD CONSTRAINT "pms_action_flows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pms_seat_senders" ADD CONSTRAINT "pms_seat_senders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pms_write_authorizations" ADD CONSTRAINT "pms_write_authorizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pms_write_queue" ADD CONSTRAINT "pms_write_queue_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "agent_deployments_uq" ON "agent_deployments" USING btree ("organization_id","persona_id","provider");
CREATE INDEX "agent_deployments_lookup_idx" ON "agent_deployments" USING btree ("organization_id","persona_id","status");
CREATE INDEX "organization_seat_slugs_org_idx" ON "organization_seat_slugs" USING btree ("organization_id");
CREATE UNIQUE INDEX "pms_action_flow_uq" ON "pms_action_flows" USING btree ("organization_id","provider","action","version");
CREATE INDEX "pms_action_flow_lookup_idx" ON "pms_action_flows" USING btree ("organization_id","provider","action","status");
CREATE INDEX "pms_seat_messages_org_idx" ON "pms_seat_messages" USING btree ("organization_id","disposition");
CREATE INDEX "pms_seat_messages_held_idx" ON "pms_seat_messages" USING btree ("organization_id","authenticated_domain");
CREATE INDEX "pms_seat_messages_digest_idx" ON "pms_seat_messages" USING btree ("digest");
CREATE UNIQUE INDEX "pms_seat_senders_uq" ON "pms_seat_senders" USING btree ("organization_id","domain");
CREATE INDEX "pms_seat_senders_org_idx" ON "pms_seat_senders" USING btree ("organization_id");
CREATE UNIQUE INDEX "pms_write_auth_uq" ON "pms_write_authorizations" USING btree ("organization_id","provider","action");
CREATE INDEX "pms_write_auth_org_idx" ON "pms_write_authorizations" USING btree ("organization_id","status");
CREATE UNIQUE INDEX "pms_write_queue_idem_uq" ON "pms_write_queue" USING btree ("organization_id","idempotency_key");
CREATE INDEX "pms_write_queue_drain_idx" ON "pms_write_queue" USING btree ("organization_id","status","created_at");
-- The workspace's current seat address. A column rather than a lookup because a
-- seat slug is chosen once by an operator and never reissued: retired slugs keep
-- working and live in organization_seat_slugs above. Nullable because a
-- workspace that has never claimed a seat has no address, which is not the same
-- as an empty one.
ALTER TABLE "organizations" ADD COLUMN "seat_slug" text;

-- Unique across every workspace, not per workspace: the slug is the local part
-- of an inbound address, so two workspaces sharing one would make the recipient
-- ambiguous and inbound mail unroutable.
CREATE UNIQUE INDEX "organizations_seat_slug_uq" ON "organizations" USING btree ("seat_slug");

-- Row-level security in the shape generate-rls.mjs produces for every other
-- tenant table: default deny, reads for anyone with access to the organization,
-- writes for the roles that operate it. Each table carries organization_id, so
-- none needs the property-scoped variant.
ALTER TABLE public."agent_deployments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."agent_deployments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_deployments_select" ON public."agent_deployments";
CREATE POLICY "agent_deployments_select" ON public."agent_deployments"
  FOR SELECT TO aval_app
  USING (aval_private.has_org_access(organization_id));
DROP POLICY IF EXISTS "agent_deployments_insert" ON public."agent_deployments";
CREATE POLICY "agent_deployments_insert" ON public."agent_deployments"
  FOR INSERT TO aval_app
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "agent_deployments_update" ON public."agent_deployments";
CREATE POLICY "agent_deployments_update" ON public."agent_deployments"
  FOR UPDATE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']))
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "agent_deployments_delete" ON public."agent_deployments";
CREATE POLICY "agent_deployments_delete" ON public."agent_deployments"
  FOR DELETE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
ALTER TABLE public."organization_seat_slugs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."organization_seat_slugs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_seat_slugs_select" ON public."organization_seat_slugs";
CREATE POLICY "organization_seat_slugs_select" ON public."organization_seat_slugs"
  FOR SELECT TO aval_app
  USING (aval_private.has_org_access(organization_id));
DROP POLICY IF EXISTS "organization_seat_slugs_insert" ON public."organization_seat_slugs";
CREATE POLICY "organization_seat_slugs_insert" ON public."organization_seat_slugs"
  FOR INSERT TO aval_app
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "organization_seat_slugs_update" ON public."organization_seat_slugs";
CREATE POLICY "organization_seat_slugs_update" ON public."organization_seat_slugs"
  FOR UPDATE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']))
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "organization_seat_slugs_delete" ON public."organization_seat_slugs";
CREATE POLICY "organization_seat_slugs_delete" ON public."organization_seat_slugs"
  FOR DELETE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
ALTER TABLE public."pms_action_flows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."pms_action_flows" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pms_action_flows_select" ON public."pms_action_flows";
CREATE POLICY "pms_action_flows_select" ON public."pms_action_flows"
  FOR SELECT TO aval_app
  USING (aval_private.has_org_access(organization_id));
DROP POLICY IF EXISTS "pms_action_flows_insert" ON public."pms_action_flows";
CREATE POLICY "pms_action_flows_insert" ON public."pms_action_flows"
  FOR INSERT TO aval_app
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "pms_action_flows_update" ON public."pms_action_flows";
CREATE POLICY "pms_action_flows_update" ON public."pms_action_flows"
  FOR UPDATE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']))
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "pms_action_flows_delete" ON public."pms_action_flows";
CREATE POLICY "pms_action_flows_delete" ON public."pms_action_flows"
  FOR DELETE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
ALTER TABLE public."pms_seat_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."pms_seat_messages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pms_seat_messages_select" ON public."pms_seat_messages";
CREATE POLICY "pms_seat_messages_select" ON public."pms_seat_messages"
  FOR SELECT TO aval_app
  USING (aval_private.has_org_access(organization_id));
DROP POLICY IF EXISTS "pms_seat_messages_insert" ON public."pms_seat_messages";
CREATE POLICY "pms_seat_messages_insert" ON public."pms_seat_messages"
  FOR INSERT TO aval_app
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "pms_seat_messages_update" ON public."pms_seat_messages";
CREATE POLICY "pms_seat_messages_update" ON public."pms_seat_messages"
  FOR UPDATE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']))
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "pms_seat_messages_delete" ON public."pms_seat_messages";
CREATE POLICY "pms_seat_messages_delete" ON public."pms_seat_messages"
  FOR DELETE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
ALTER TABLE public."pms_seat_senders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."pms_seat_senders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pms_seat_senders_select" ON public."pms_seat_senders";
CREATE POLICY "pms_seat_senders_select" ON public."pms_seat_senders"
  FOR SELECT TO aval_app
  USING (aval_private.has_org_access(organization_id));
DROP POLICY IF EXISTS "pms_seat_senders_insert" ON public."pms_seat_senders";
CREATE POLICY "pms_seat_senders_insert" ON public."pms_seat_senders"
  FOR INSERT TO aval_app
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "pms_seat_senders_update" ON public."pms_seat_senders";
CREATE POLICY "pms_seat_senders_update" ON public."pms_seat_senders"
  FOR UPDATE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']))
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "pms_seat_senders_delete" ON public."pms_seat_senders";
CREATE POLICY "pms_seat_senders_delete" ON public."pms_seat_senders"
  FOR DELETE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
ALTER TABLE public."pms_write_authorizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."pms_write_authorizations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pms_write_authorizations_select" ON public."pms_write_authorizations";
CREATE POLICY "pms_write_authorizations_select" ON public."pms_write_authorizations"
  FOR SELECT TO aval_app
  USING (aval_private.has_org_access(organization_id));
DROP POLICY IF EXISTS "pms_write_authorizations_insert" ON public."pms_write_authorizations";
CREATE POLICY "pms_write_authorizations_insert" ON public."pms_write_authorizations"
  FOR INSERT TO aval_app
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "pms_write_authorizations_update" ON public."pms_write_authorizations";
CREATE POLICY "pms_write_authorizations_update" ON public."pms_write_authorizations"
  FOR UPDATE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']))
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "pms_write_authorizations_delete" ON public."pms_write_authorizations";
CREATE POLICY "pms_write_authorizations_delete" ON public."pms_write_authorizations"
  FOR DELETE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
ALTER TABLE public."pms_write_queue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."pms_write_queue" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pms_write_queue_select" ON public."pms_write_queue";
CREATE POLICY "pms_write_queue_select" ON public."pms_write_queue"
  FOR SELECT TO aval_app
  USING (aval_private.has_org_access(organization_id));
DROP POLICY IF EXISTS "pms_write_queue_insert" ON public."pms_write_queue";
CREATE POLICY "pms_write_queue_insert" ON public."pms_write_queue"
  FOR INSERT TO aval_app
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "pms_write_queue_update" ON public."pms_write_queue";
CREATE POLICY "pms_write_queue_update" ON public."pms_write_queue"
  FOR UPDATE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']))
  WITH CHECK (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
DROP POLICY IF EXISTS "pms_write_queue_delete" ON public."pms_write_queue";
CREATE POLICY "pms_write_queue_delete" ON public."pms_write_queue"
  FOR DELETE TO aval_app
  USING (aval_private.has_org_role(organization_id, ARRAY['org_admin','regional_manager','property_manager','operator']));
