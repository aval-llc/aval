CREATE TABLE `attempt_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text,
	`tool_name` text,
	`work_type` text,
	`risk_class` text,
	`max_attempts` integer,
	`max_elapsed_ms` integer,
	`initial_delay_ms` integer DEFAULT 0 NOT NULL,
	`backoff_strategy` text DEFAULT 'fixed' NOT NULL,
	`backoff_factor` real DEFAULT 2 NOT NULL,
	`max_delay_ms` integer,
	`on_exhausted` text DEFAULT 'human_handoff' NOT NULL,
	`on_contradicted` text DEFAULT 'human_handoff' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attempt_policies_kind" CHECK(kind IN ('verification','check_repair','replan')),
	CONSTRAINT "attempt_policies_backoff" CHECK(backoff_strategy IN ('fixed','linear','exponential')),
	CONSTRAINT "attempt_policies_on_exhausted" CHECK(on_exhausted IN ('human_handoff','replan','fail')),
	CONSTRAINT "attempt_policies_on_contradicted" CHECK(on_contradicted IN ('human_handoff','replan','fail')),
	CONSTRAINT "attempt_policies_attempts_positive" CHECK(max_attempts IS NULL OR max_attempts >= 1),
	CONSTRAINT "attempt_policies_elapsed_positive" CHECK(max_elapsed_ms IS NULL OR max_elapsed_ms >= 0),
	CONSTRAINT "attempt_policies_delay_nonnegative" CHECK(initial_delay_ms >= 0),
	CONSTRAINT "attempt_policies_factor_positive" CHECK(backoff_factor > 0)
);
--> statement-breakpoint
CREATE INDEX `attempt_policies_lookup_idx` ON `attempt_policies` (`organization_id`,`kind`,`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_policies_selector_uq` ON `attempt_policies` (`organization_id`,`kind`,`provider`,`tool_name`,`work_type`,`risk_class`);