CREATE TABLE `action_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`task_id` text NOT NULL,
	`action_execution_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`claim` text NOT NULL,
	`expected_state_json` text DEFAULT '{}' NOT NULL,
	`evidence_type` text NOT NULL,
	`source_provider` text,
	`external_record_id` text,
	`observed_state_json` text DEFAULT '{}' NOT NULL,
	`observed_at` integer,
	`verification_result` text NOT NULL,
	`payload_ref` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `agent_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "action_evidence_type" CHECK(evidence_type IN ('provider_reread','provider_event','human_confirmation','document','aval_native')),
	CONSTRAINT "action_evidence_result" CHECK(verification_result IN ('confirmed','contradicted','inconclusive'))
);
--> statement-breakpoint
CREATE INDEX `action_evidence_task_idx` ON `action_evidence` (`organization_id`,`task_id`);--> statement-breakpoint
CREATE INDEX `action_evidence_execution_idx` ON `action_evidence` (`action_execution_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `action_evidence_observation_uq` ON `action_evidence` (`action_execution_id`,`evidence_type`,`external_record_id`,`verification_result`);--> statement-breakpoint
CREATE TABLE `operational_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`fact_type` text NOT NULL,
	`value` text,
	`value_ref` text,
	`source_type` text NOT NULL,
	`source_provider` text,
	`source_record_id` text,
	`observed_at` integer,
	`synced_at` integer NOT NULL,
	`expires_at` integer,
	`freshness_policy` text,
	`authoritativeness` text NOT NULL,
	`confidence` real,
	`derived_from_json` text DEFAULT '[]' NOT NULL,
	`conflict_state` text DEFAULT 'none' NOT NULL,
	`superseded_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "operational_facts_source_type" CHECK(source_type IN ('provider','aval_native','human','document','inference')),
	CONSTRAINT "operational_facts_authority" CHECK(authoritativeness IN ('authoritative','reported','inferred','human_confirmed')),
	CONSTRAINT "operational_facts_conflict_state" CHECK(conflict_state IN ('none','conflicted','superseded')),
	CONSTRAINT "operational_facts_confidence_range" CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
	CONSTRAINT "operational_facts_confidence_scope" CHECK((source_type = 'inference') = (confidence IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `operational_facts_entity_idx` ON `operational_facts` (`organization_id`,`entity_type`,`entity_id`,`fact_type`);--> statement-breakpoint
CREATE INDEX `operational_facts_conflict_idx` ON `operational_facts` (`organization_id`,`conflict_state`);--> statement-breakpoint
CREATE UNIQUE INDEX `operational_facts_source_uq` ON `operational_facts` (`organization_id`,`entity_type`,`entity_id`,`fact_type`,`source_type`,`source_provider`);