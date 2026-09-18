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
--> statement-breakpoint
CREATE TABLE "organization_seat_slugs" (
	"slug" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "pms_seat_senders" (
	"organization_id" text NOT NULL,
	"domain" text NOT NULL,
	"provider_id" text NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "seat_slug" text;--> statement-breakpoint
ALTER TABLE "agent_deployments" ADD CONSTRAINT "agent_deployments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_seat_slugs" ADD CONSTRAINT "organization_seat_slugs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pms_action_flows" ADD CONSTRAINT "pms_action_flows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pms_seat_senders" ADD CONSTRAINT "pms_seat_senders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pms_write_authorizations" ADD CONSTRAINT "pms_write_authorizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pms_write_queue" ADD CONSTRAINT "pms_write_queue_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_deployments_uq" ON "agent_deployments" USING btree ("organization_id","persona_id","provider");--> statement-breakpoint
CREATE INDEX "agent_deployments_lookup_idx" ON "agent_deployments" USING btree ("organization_id","persona_id","status");--> statement-breakpoint
CREATE INDEX "organization_seat_slugs_org_idx" ON "organization_seat_slugs" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pms_action_flow_uq" ON "pms_action_flows" USING btree ("organization_id","provider","action","version");--> statement-breakpoint
CREATE INDEX "pms_action_flow_lookup_idx" ON "pms_action_flows" USING btree ("organization_id","provider","action","status");--> statement-breakpoint
CREATE INDEX "pms_seat_messages_org_idx" ON "pms_seat_messages" USING btree ("organization_id","disposition");--> statement-breakpoint
CREATE INDEX "pms_seat_messages_held_idx" ON "pms_seat_messages" USING btree ("organization_id","authenticated_domain");--> statement-breakpoint
CREATE INDEX "pms_seat_messages_digest_idx" ON "pms_seat_messages" USING btree ("digest");--> statement-breakpoint
CREATE UNIQUE INDEX "pms_seat_senders_uq" ON "pms_seat_senders" USING btree ("organization_id","domain");--> statement-breakpoint
CREATE INDEX "pms_seat_senders_org_idx" ON "pms_seat_senders" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pms_write_auth_uq" ON "pms_write_authorizations" USING btree ("organization_id","provider","action");--> statement-breakpoint
CREATE INDEX "pms_write_auth_org_idx" ON "pms_write_authorizations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pms_write_queue_idem_uq" ON "pms_write_queue" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "pms_write_queue_drain_idx" ON "pms_write_queue" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_seat_slug_uq" ON "organizations" USING btree ("seat_slug");