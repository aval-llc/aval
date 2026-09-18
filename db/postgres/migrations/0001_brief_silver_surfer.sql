DROP INDEX "rate_limit_hits_scope_created_idx";--> statement-breakpoint
ALTER TABLE "access_grants" ALTER COLUMN "capabilities_json" SET DEFAULT '[]';--> statement-breakpoint
ALTER TABLE "agent_approvals" ALTER COLUMN "evidence_json" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "agent_execution_policies" ALTER COLUMN "allowed_currencies_json" SET DEFAULT '["USD"]';--> statement-breakpoint
ALTER TABLE "agent_execution_policies" ALTER COLUMN "allowed_account_fingerprints_json" SET DEFAULT '[]';--> statement-breakpoint
ALTER TABLE "agent_tasks" ALTER COLUMN "execution_scope_json" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "agent_tasks" ALTER COLUMN "check_json" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "agent_tasks" ALTER COLUMN "transcript_json" SET DEFAULT '[]';--> statement-breakpoint
ALTER TABLE "ai_usage" ALTER COLUMN "day" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "automation_steps" ALTER COLUMN "payload_json" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "communication_settings" ALTER COLUMN "config_json" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "draft_documents" ALTER COLUMN "metrics_json" SET DEFAULT '[]';--> statement-breakpoint
ALTER TABLE "integration_connections" ALTER COLUMN "scopes_json" SET DEFAULT '[]';--> statement-breakpoint
ALTER TABLE "integration_connections" ALTER COLUMN "metadata_json" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "integration_sync_state" ALTER COLUMN "cursor_json" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "leases" ALTER COLUMN "start_date" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "leases" ALTER COLUMN "end_date" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "leases" ALTER COLUMN "move_in_date" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "leases" ALTER COLUMN "move_out_date" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "due_at" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "payload_json" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "planning_items" ALTER COLUMN "starts_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "planning_items" ALTER COLUMN "ends_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "planning_items" ALTER COLUMN "updated_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "planning_projects" ALTER COLUMN "created_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ALTER COLUMN "period_start" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ALTER COLUMN "period_end" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "sso_connections" ALTER COLUMN "permitted_domains_json" SET DEFAULT '[]';--> statement-breakpoint
ALTER TABLE "sync_runs" ALTER COLUMN "cursor_json" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "sync_runs" ALTER COLUMN "counts_json" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "units" ALTER COLUMN "vacant_since" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "utility_bills" ALTER COLUMN "period_start" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "utility_bills" ALTER COLUMN "period_end" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "vendors" ALTER COLUMN "insurance_expires_at" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD COLUMN "property_id" text;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "lease_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_worker_runs" ADD COLUMN "organization_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "lease_residents" ADD COLUMN "source_provider" text;--> statement-breakpoint
ALTER TABLE "lease_residents" ADD COLUMN "source_connection_id" text;--> statement-breakpoint
ALTER TABLE "rate_limit_hits" ADD COLUMN "organization_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_org_property_fk" FOREIGN KEY ("organization_id","property_id") REFERENCES "public"."properties"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_worker_runs" ADD CONSTRAINT "agent_worker_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_hits" ADD CONSTRAINT "rate_limit_hits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_approvals_org_property_status_idx" ON "agent_approvals" USING btree ("organization_id","property_id","status");--> statement-breakpoint
CREATE INDEX "rate_limit_hits_org_scope_created_idx" ON "rate_limit_hits" USING btree ("organization_id","scope_key","created_at");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";