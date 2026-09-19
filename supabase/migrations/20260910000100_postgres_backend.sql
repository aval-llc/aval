-- Generated from db/postgres/migrations/0000_superb_black_knight.sql.
CREATE TABLE "access_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"role" text NOT NULL,
	"organization_scope" boolean DEFAULT false NOT NULL,
	"ownership_entity_id" text,
	"portfolio_id" text,
	"region_id" text,
	"property_id" text,
	"capabilities_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_principal_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "access_grants_role_ck" CHECK ("access_grants"."role" in ('org_admin','regional_manager','property_manager','approver','operator','viewer','owner_viewer')),
	CONSTRAINT "access_grants_one_scope_ck" CHECK (
    (case when "access_grants"."organization_scope" then 1 else 0 end) +
    (case when "access_grants"."ownership_entity_id" is not null then 1 else 0 end) +
    (case when "access_grants"."portfolio_id" is not null then 1 else 0 end) +
    (case when "access_grants"."region_id" is not null then 1 else 0 end) +
    (case when "access_grants"."property_id" is not null then 1 else 0 end) = 1
  )
);
--> statement-breakpoint
CREATE TABLE "agent_approval_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"approval_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"tool_name" text NOT NULL,
	"risk_level" text NOT NULL,
	"tier" text NOT NULL,
	"amount_cents" bigint,
	"currency" text,
	"evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" text,
	"decision_note" text,
	"required_approvals" integer DEFAULT 1 NOT NULL,
	"approvals_received" integer DEFAULT 0 NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"exit_code" integer NOT NULL,
	"output_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_execution_policies" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"single_approval_max_cents" bigint DEFAULT 50000 NOT NULL,
	"hard_ceiling_cents" bigint DEFAULT 2500000 NOT NULL,
	"daily_limit_cents" bigint DEFAULT 5000000 NOT NULL,
	"allowed_currencies_json" jsonb DEFAULT '["USD"]'::jsonb NOT NULL,
	"allowed_account_fingerprints_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_financial_events" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"payload_digest" text NOT NULL,
	"external_transaction_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_financial_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"approval_id" text,
	"step_index" integer NOT NULL,
	"tool_name" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"account_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"reconciliation_status" text DEFAULT 'pending' NOT NULL,
	"external_transaction_id" text,
	"result_digest" text,
	"discrepancy_code" text,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
	"next_reconcile_at" timestamp with time zone NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"reconcile_lease_owner" text,
	"reconcile_lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"request_key" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_model_contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"context_json" jsonb NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_personas" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"label" text NOT NULL,
	"focus_description" text NOT NULL,
	"tool_names_json" jsonb,
	"shape" text NOT NULL,
	"theme" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_plan_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"root_task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"node_key" text NOT NULL,
	"task_id" text NOT NULL,
	"dependencies_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_task_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"step_index" integer NOT NULL,
	"kind" text NOT NULL,
	"model_provider" text,
	"model_name" text,
	"tool_name" text,
	"policy_effect" text,
	"deny_code" text,
	"risk_level" text,
	"args_digest" text,
	"result_digest" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"duration_ms" integer,
	"idempotency_key" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"goal" text NOT NULL,
	"status" text NOT NULL,
	"execution_scope_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"check_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deadline_at" timestamp with time zone,
	"transcript_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"step_count" integer DEFAULT 0 NOT NULL,
	"max_steps" integer NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"max_tokens" bigint NOT NULL,
	"execution_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"parent_task_id" text,
	"delegation_depth" integer DEFAULT 0 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"result_json" jsonb,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_worker_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"tasks_scanned" integer DEFAULT 0 NOT NULL,
	"tasks_advanced" integer DEFAULT 0 NOT NULL,
	"tasks_completed" integer DEFAULT 0 NOT NULL,
	"tasks_failed" integer DEFAULT 0 NOT NULL,
	"tasks_parked" integer DEFAULT 0 NOT NULL,
	"error_digest" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"day" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answer_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"payload_digest" text NOT NULL,
	"count" integer NOT NULL,
	"previous_hash" text NOT NULL,
	"entry_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_authorities" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"access_grant_id" text NOT NULL,
	"action" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"maximum_amount_cents" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_authorities_amount_ck" CHECK ("approval_authorities"."maximum_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"insight_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_label" text NOT NULL,
	"summary" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"request_key" text NOT NULL,
	"payload_digest" text NOT NULL,
	"kind" text NOT NULL,
	"destination" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"provider_id" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_poll_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"resource_id" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "communication_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"channel" text NOT NULL,
	"external_thread_id" text NOT NULL,
	"contact_display_name" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"register" text DEFAULT 'professional' NOT NULL,
	"draft_reply" text,
	"draft_reply_status" text,
	"draft_reply_at" timestamp with time zone,
	"last_message_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"content_text" text NOT NULL,
	"char_count" integer NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"format" text NOT NULL,
	"status" text NOT NULL,
	"headline" text,
	"narrative" text,
	"document_type" text,
	"document_markdown" text,
	"metrics_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chart_json" jsonb,
	"confidence" text,
	"error_message" text,
	"sent_to" text,
	"module_label" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source" text NOT NULL,
	"stage" text NOT NULL,
	"count" integer NOT NULL,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gl_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"account_type" text NOT NULL,
	"is_trust_account" boolean DEFAULT false NOT NULL,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"source_connection_id" text,
	"external_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gl_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"property_id" text,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"memo" text,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"source_connection_id" text,
	"external_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_links" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"email_at_link" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "insight_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"insight_id" text NOT NULL,
	"decision" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"auth_mode" text NOT NULL,
	"external_account_id" text,
	"external_account_name" text,
	"scopes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token_ciphertext" text,
	"refresh_token_ciphertext" text,
	"expires_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"connection_id" text,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_sync_state" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"external_account_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cursor_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learned_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"topic" text NOT NULL,
	"statement" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lease_residents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"lease_id" text NOT NULL,
	"resident_id" text NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"unit_id" text NOT NULL,
	"property_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone,
	"is_month_to_month" boolean DEFAULT false NOT NULL,
	"move_in_date" timestamp with time zone,
	"move_out_date" timestamp with time zone,
	"rent_cents" bigint NOT NULL,
	"deposit_cents" bigint DEFAULT 0 NOT NULL,
	"rent_due_day" integer DEFAULT 1 NOT NULL,
	"renewal_of_lease_id" text,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"source_connection_id" text,
	"external_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leasing_leads" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"property_id" text,
	"unit_id" text,
	"resident_id" text,
	"channel" text,
	"unit_type_label" text,
	"stage" text DEFAULT 'inquiry' NOT NULL,
	"inquired_at" timestamp with time zone NOT NULL,
	"contacted_at" timestamp with time zone,
	"toured_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"lost_reason" text,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"source_connection_id" text,
	"external_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"lease_id" text NOT NULL,
	"property_id" text NOT NULL,
	"entry_type" text NOT NULL,
	"category" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"memo" text,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"source_connection_id" text,
	"external_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"external_message_id" text NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"user_id" text NOT NULL,
	"code_verifier" text,
	"return_to" text DEFAULT '/?view=connections' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations_conflicts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"field" text NOT NULL,
	"value_a" text NOT NULL,
	"source_a" text NOT NULL,
	"value_b" text NOT NULL,
	"source_b" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organization_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"role" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by_user_id" text,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"invited_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"active_model_provider" text,
	"default_persona_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ownership_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"external_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planning_items" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'task' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"project_id" text,
	"assignee_id" text,
	"starts_at" integer NOT NULL,
	"ends_at" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planning_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text DEFAULT 'blue' NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source" text NOT NULL,
	"metric_key" text NOT NULL,
	"numeric_value" integer,
	"text_value" text,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'human' NOT NULL,
	"display_name" text NOT NULL,
	"primary_email" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "principals_kind_ck" CHECK ("principals"."kind" in ('human','service'))
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ownership_entity_id" text,
	"portfolio_id" text,
	"region_id" text,
	"name" text NOT NULL,
	"address_line1" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country" text DEFAULT 'US' NOT NULL,
	"property_type" text DEFAULT 'multifamily' NOT NULL,
	"reported_unit_count" integer,
	"year_built" integer,
	"square_feet" integer,
	"acquisition_cost_cents" bigint,
	"current_value_cents" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"source_connection_id" text,
	"external_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_hits" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "residents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"phone" text,
	"status" text DEFAULT 'current' NOT NULL,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"source_connection_id" text,
	"external_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"supabase_provider_id" text,
	"permitted_domains_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enforcement" text DEFAULT 'disabled' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sso_connections_enforcement_ck" CHECK ("sso_connections"."enforcement" in ('disabled','optional','required'))
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"status" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"cursor_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counts_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "token_top_ups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"stripe_session_id" text NOT NULL,
	"pack_id" text NOT NULL,
	"tokens_granted" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"property_id" text NOT NULL,
	"unit_number" text NOT NULL,
	"bedrooms" integer,
	"bathrooms" double precision,
	"square_feet" integer,
	"market_rent_cents" bigint,
	"status" text DEFAULT 'vacant_ready' NOT NULL,
	"vacant_since" timestamp with time zone,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"source_connection_id" text,
	"external_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_appearance" (
	"user_id" text PRIMARY KEY NOT NULL,
	"preferences" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_onboarding" (
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"preferences" text NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"intro_seen" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "utility_bills" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"meter_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"usage_amount" numeric(20, 6) NOT NULL,
	"cost_cents" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"source" text NOT NULL,
	"extraction_confidence" text,
	"extraction_note" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "utility_meters" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"utility_type" text NOT NULL,
	"property_label" text NOT NULL,
	"unit_label" text,
	"meter_number" text,
	"provider" text,
	"unit_of_measure" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"trade" text,
	"email" text,
	"phone" text,
	"insurance_expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"source_connection_id" text,
	"external_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"property_id" text NOT NULL,
	"unit_id" text,
	"lease_id" text,
	"category" text DEFAULT 'general' NOT NULL,
	"priority" text DEFAULT 'routine' NOT NULL,
	"status" text DEFAULT 'reported' NOT NULL,
	"summary" text NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"assigned_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"vendor_id" text,
	"estimate_cents" bigint,
	"actual_cost_cents" bigint,
	"callback_of_work_order_id" text,
	"source_provider" text DEFAULT 'manual' NOT NULL,
	"source_connection_id" text,
	"external_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"minute" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "access_grants_org_id_uq" ON "access_grants" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_approval_decisions_approval_user_uq" ON "agent_approval_decisions" USING btree ("approval_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_approvals_task_step_uq" ON "agent_approvals" USING btree ("task_id","step_index");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_financial_events_operation_sequence_uq" ON "agent_financial_events" USING btree ("operation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_financial_operations_idempotency_uq" ON "agent_financial_operations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_financial_operations_external_uq" ON "agent_financial_operations" USING btree ("tool_name","external_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_request_uq" ON "agent_memory" USING btree ("organization_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_plan_node_uq" ON "agent_plan_nodes" USING btree ("root_task_id","revision","node_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_steps_task_sequence_uq" ON "agent_task_steps" USING btree ("task_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_steps_idempotency_uq" ON "agent_task_steps" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "answer_audit_log_org_sequence_uq" ON "answer_audit_log" USING btree ("organization_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_authorities_grant_action_currency_uq" ON "approval_authorities" USING btree ("access_grant_id","action","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "communication_deliveries_org_request_uq" ON "communication_deliveries" USING btree ("organization_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "communication_poll_source_uq" ON "communication_poll_sources" USING btree ("organization_id","provider","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_org_channel_external_uq" ON "conversations" USING btree ("organization_id","channel","external_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gl_accounts_org_code_uq" ON "gl_accounts" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "gl_transactions_org_source_external_uq" ON "gl_transactions" USING btree ("organization_id","source_provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_provider_subject_uq" ON "identity_links" USING btree ("provider","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_org_provider_uq" ON "integration_connections" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_events_provider_external_uq" ON "integration_events" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "learned_preferences_org_topic_uq" ON "learned_preferences" USING btree ("organization_id","topic");--> statement-breakpoint
CREATE UNIQUE INDEX "lease_residents_lease_resident_uq" ON "lease_residents" USING btree ("lease_id","resident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leases_org_source_external_uq" ON "leases" USING btree ("organization_id","source_provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leasing_leads_org_source_external_uq" ON "leasing_leads" USING btree ("organization_id","source_provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_org_source_external_uq" ON "ledger_entries" USING btree ("organization_id","source_provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_external_uq" ON "messages" USING btree ("conversation_id","external_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operations_conflicts_entity_field_uq" ON "operations_conflicts" USING btree ("organization_id","entity_type","entity_id","field");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invitations_code_uq" ON "organization_invitations" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_org_user_uq" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ownership_entities_org_id_uq" ON "ownership_entities" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ownership_entities_org_external_uq" ON "ownership_entities" USING btree ("organization_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolios_org_id_uq" ON "portfolios" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolios_org_name_uq" ON "portfolios" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "properties_org_id_uq" ON "properties" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "properties_org_source_external_uq" ON "properties" USING btree ("organization_id","source_provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "regions_org_id_uq" ON "regions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "regions_org_code_uq" ON "regions" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "residents_org_source_external_uq" ON "residents" USING btree ("organization_id","source_provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connections_org_uq" ON "sso_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_org_uq" ON "subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "token_top_ups_session_uq" ON "token_top_ups" USING btree ("stripe_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "units_org_source_external_uq" ON "units" USING btree ("organization_id","source_provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_onboarding_user_org_uq" ON "user_onboarding" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_org_source_external_uq" ON "vendors" USING btree ("organization_id","source_provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_orders_org_source_external_uq" ON "work_orders" USING btree ("organization_id","source_provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_usage_subject_minute" ON "workspace_usage" USING btree ("organization_id","user_id","minute");
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_ownership_entity_id_ownership_entities_id_fk" FOREIGN KEY ("ownership_entity_id") REFERENCES "public"."ownership_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_created_by_principal_id_principals_id_fk" FOREIGN KEY ("created_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_org_owner_fk" FOREIGN KEY ("organization_id","ownership_entity_id") REFERENCES "public"."ownership_entities"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_org_portfolio_fk" FOREIGN KEY ("organization_id","portfolio_id") REFERENCES "public"."portfolios"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_org_region_fk" FOREIGN KEY ("organization_id","region_id") REFERENCES "public"."regions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_org_property_fk" FOREIGN KEY ("organization_id","property_id") REFERENCES "public"."properties"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_decisions" ADD CONSTRAINT "agent_approval_decisions_approval_id_agent_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."agent_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_decisions" ADD CONSTRAINT "agent_approval_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_checks" ADD CONSTRAINT "agent_checks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_checks" ADD CONSTRAINT "agent_checks_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_execution_policies" ADD CONSTRAINT "agent_execution_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_financial_events" ADD CONSTRAINT "agent_financial_events_operation_id_agent_financial_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."agent_financial_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_financial_events" ADD CONSTRAINT "agent_financial_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_financial_operations" ADD CONSTRAINT "agent_financial_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_financial_operations" ADD CONSTRAINT "agent_financial_operations_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_financial_operations" ADD CONSTRAINT "agent_financial_operations_approval_id_agent_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."agent_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_model_contexts" ADD CONSTRAINT "agent_model_contexts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_model_contexts" ADD CONSTRAINT "agent_model_contexts_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_personas" ADD CONSTRAINT "agent_personas_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_plan_nodes" ADD CONSTRAINT "agent_plan_nodes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_plan_nodes" ADD CONSTRAINT "agent_plan_nodes_root_task_id_agent_tasks_id_fk" FOREIGN KEY ("root_task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_plan_nodes" ADD CONSTRAINT "agent_plan_nodes_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_steps" ADD CONSTRAINT "agent_task_steps_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_audit_log" ADD CONSTRAINT "answer_audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_authorities" ADD CONSTRAINT "approval_authorities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_authorities" ADD CONSTRAINT "approval_authorities_access_grant_id_access_grants_id_fk" FOREIGN KEY ("access_grant_id") REFERENCES "public"."access_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_authorities" ADD CONSTRAINT "approval_authorities_org_grant_fk" FOREIGN KEY ("organization_id","access_grant_id") REFERENCES "public"."access_grants"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_deliveries" ADD CONSTRAINT "communication_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_deliveries" ADD CONSTRAINT "communication_deliveries_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_poll_sources" ADD CONSTRAINT "communication_poll_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_settings" ADD CONSTRAINT "communication_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_documents" ADD CONSTRAINT "draft_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_snapshots" ADD CONSTRAINT "funnel_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_source_connection_id_integration_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_transactions" ADD CONSTRAINT "gl_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_transactions" ADD CONSTRAINT "gl_transactions_account_id_gl_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_transactions" ADD CONSTRAINT "gl_transactions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_transactions" ADD CONSTRAINT "gl_transactions_source_connection_id_integration_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_decisions" ADD CONSTRAINT "insight_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_state" ADD CONSTRAINT "integration_sync_state_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_state" ADD CONSTRAINT "integration_sync_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_preferences" ADD CONSTRAINT "learned_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_residents" ADD CONSTRAINT "lease_residents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_residents" ADD CONSTRAINT "lease_residents_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_residents" ADD CONSTRAINT "lease_residents_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_source_connection_id_integration_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leasing_leads" ADD CONSTRAINT "leasing_leads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leasing_leads" ADD CONSTRAINT "leasing_leads_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leasing_leads" ADD CONSTRAINT "leasing_leads_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leasing_leads" ADD CONSTRAINT "leasing_leads_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leasing_leads" ADD CONSTRAINT "leasing_leads_source_connection_id_integration_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_source_connection_id_integration_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_conflicts" ADD CONSTRAINT "operations_conflicts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_entities" ADD CONSTRAINT "ownership_entities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_items" ADD CONSTRAINT "planning_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_items" ADD CONSTRAINT "planning_items_project_id_planning_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."planning_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_projects" ADD CONSTRAINT "planning_projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_ownership_entity_id_ownership_entities_id_fk" FOREIGN KEY ("ownership_entity_id") REFERENCES "public"."ownership_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_source_connection_id_integration_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_org_owner_fk" FOREIGN KEY ("organization_id","ownership_entity_id") REFERENCES "public"."ownership_entities"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_org_portfolio_fk" FOREIGN KEY ("organization_id","portfolio_id") REFERENCES "public"."portfolios"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_org_region_fk" FOREIGN KEY ("organization_id","region_id") REFERENCES "public"."regions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regions" ADD CONSTRAINT "regions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "residents" ADD CONSTRAINT "residents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "residents" ADD CONSTRAINT "residents_source_connection_id_integration_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_top_ups" ADD CONSTRAINT "token_top_ups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_source_connection_id_integration_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_bills" ADD CONSTRAINT "utility_bills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_bills" ADD CONSTRAINT "utility_bills_meter_id_utility_meters_id_fk" FOREIGN KEY ("meter_id") REFERENCES "public"."utility_meters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_meters" ADD CONSTRAINT "utility_meters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_source_connection_id_integration_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_source_connection_id_integration_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage" ADD CONSTRAINT "workspace_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grants_principal_org_idx" ON "access_grants" USING btree ("principal_id","organization_id");--> statement-breakpoint
CREATE INDEX "access_grants_property_idx" ON "access_grants" USING btree ("organization_id","property_id");--> statement-breakpoint
CREATE INDEX "agent_approval_decisions_org_created_idx" ON "agent_approval_decisions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_approvals_org_status_idx" ON "agent_approvals" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "agent_checks_task_idx" ON "agent_checks" USING btree ("organization_id","task_id");--> statement-breakpoint
CREATE INDEX "agent_financial_events_org_created_idx" ON "agent_financial_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_financial_operations_reconcile_idx" ON "agent_financial_operations" USING btree ("reconciliation_status","next_reconcile_at","reconcile_lease_expires_at");--> statement-breakpoint
CREATE INDEX "agent_financial_operations_org_created_idx" ON "agent_financial_operations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_memory_task_step_idx" ON "agent_memory" USING btree ("task_id","step_index");--> statement-breakpoint
CREATE INDEX "agent_model_context_task_idx" ON "agent_model_contexts" USING btree ("organization_id","task_id","step_index");--> statement-breakpoint
CREATE INDEX "agent_personas_org_idx" ON "agent_personas" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agent_plan_root_idx" ON "agent_plan_nodes" USING btree ("root_task_id","revision");--> statement-breakpoint
CREATE INDEX "agent_task_steps_task_idx" ON "agent_task_steps" USING btree ("task_id","step_index");--> statement-breakpoint
CREATE INDEX "agent_tasks_org_created_idx" ON "agent_tasks" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_status_lease_idx" ON "agent_tasks" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_status_attempt_idx" ON "agent_tasks" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_parent_idx" ON "agent_tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "agent_worker_runs_started_idx" ON "agent_worker_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "ai_usage_org_day_idx" ON "ai_usage" USING btree ("organization_id","day");--> statement-breakpoint
CREATE INDEX "answer_audit_log_org_idx" ON "answer_audit_log" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "automation_runs_org_created_idx" ON "automation_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_steps_run_idx" ON "automation_steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "communication_deliveries_org_created_idx" ON "communication_deliveries" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "communication_poll_due_idx" ON "communication_poll_sources" USING btree ("enabled","last_attempt_at");--> statement-breakpoint
CREATE INDEX "conversations_org_status_idx" ON "conversations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "documents_org_idx" ON "documents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "draft_documents_org_created_idx" ON "draft_documents" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "funnel_snapshots_org_captured_idx" ON "funnel_snapshots" USING btree ("organization_id","captured_at");--> statement-breakpoint
CREATE INDEX "gl_accounts_org_type_idx" ON "gl_accounts" USING btree ("organization_id","account_type");--> statement-breakpoint
CREATE INDEX "gl_transactions_org_posted_idx" ON "gl_transactions" USING btree ("organization_id","posted_at");--> statement-breakpoint
CREATE INDEX "gl_transactions_org_property_idx" ON "gl_transactions" USING btree ("organization_id","property_id");--> statement-breakpoint
CREATE INDEX "identity_links_principal_idx" ON "identity_links" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "insight_decisions_org_insight_idx" ON "insight_decisions" USING btree ("organization_id","insight_id");--> statement-breakpoint
CREATE INDEX "integration_connections_org_status_idx" ON "integration_connections" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "integration_events_provider_status_idx" ON "integration_events" USING btree ("provider","status");--> statement-breakpoint
CREATE INDEX "integration_sync_due_idx" ON "integration_sync_state" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "learned_preferences_org_idx" ON "learned_preferences" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "lease_residents_org_idx" ON "lease_residents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "leases_org_status_idx" ON "leases" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "leases_org_end_idx" ON "leases" USING btree ("organization_id","end_date");--> statement-breakpoint
CREATE INDEX "leases_unit_idx" ON "leases" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "leasing_leads_org_stage_idx" ON "leasing_leads" USING btree ("organization_id","stage");--> statement-breakpoint
CREATE INDEX "leasing_leads_org_inquired_idx" ON "leasing_leads" USING btree ("organization_id","inquired_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_org_lease_idx" ON "ledger_entries" USING btree ("organization_id","lease_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_org_posted_idx" ON "ledger_entries" USING btree ("organization_id","posted_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_org_due_idx" ON "ledger_entries" USING btree ("organization_id","due_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_states_expiry_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "operations_conflicts_org_status_idx" ON "operations_conflicts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "organization_invitations_org_idx" ON "organization_invitations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "planning_items_org_date_idx" ON "planning_items" USING btree ("organization_id","starts_at");--> statement-breakpoint
CREATE INDEX "planning_projects_org_idx" ON "planning_projects" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "portfolio_snapshots_org_captured_idx" ON "portfolio_snapshots" USING btree ("organization_id","captured_at");--> statement-breakpoint
CREATE INDEX "properties_org_status_idx" ON "properties" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "rate_limit_hits_scope_created_idx" ON "rate_limit_hits" USING btree ("scope_key","created_at");--> statement-breakpoint
CREATE INDEX "residents_org_status_idx" ON "residents" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "sync_runs_connection_started_idx" ON "sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE INDEX "units_org_property_idx" ON "units" USING btree ("organization_id","property_id");--> statement-breakpoint
CREATE INDEX "units_org_status_idx" ON "units" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "utility_bills_org_period_idx" ON "utility_bills" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE INDEX "utility_bills_meter_period_idx" ON "utility_bills" USING btree ("meter_id","period_start");--> statement-breakpoint
CREATE INDEX "utility_meters_org_type_idx" ON "utility_meters" USING btree ("organization_id","utility_type");--> statement-breakpoint
CREATE INDEX "vendors_org_active_idx" ON "vendors" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE INDEX "work_orders_org_status_idx" ON "work_orders" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "work_orders_org_reported_idx" ON "work_orders" USING btree ("organization_id","reported_at");--> statement-breakpoint
CREATE INDEX "work_orders_org_vendor_idx" ON "work_orders" USING btree ("organization_id","vendor_id");--> statement-breakpoint
CREATE INDEX "work_orders_org_property_idx" ON "work_orders" USING btree ("organization_id","property_id");--> statement-breakpoint