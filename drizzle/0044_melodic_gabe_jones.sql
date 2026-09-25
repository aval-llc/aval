CREATE TABLE `employee_expertise` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`expertise_id` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`granted_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `ai_employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`expertise_id`) REFERENCES `expertise_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `employee_expertise_lookup_idx` ON `employee_expertise` (`employee_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `employee_expertise_uq` ON `employee_expertise` (`employee_id`,`expertise_id`);--> statement-breakpoint
CREATE TABLE `expertise_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`capability_tags_json` text DEFAULT '[]' NOT NULL,
	`domains_json` text DEFAULT '[]' NOT NULL,
	`routing_signals_json` text DEFAULT '[]' NOT NULL,
	`required_capabilities_json` text DEFAULT '[]' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`risk_ceiling` text DEFAULT 'low' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "expertise_profiles_risk" CHECK(risk_ceiling IN ('low','medium','high','critical')),
	CONSTRAINT "expertise_profiles_slug_shape" CHECK(slug = lower(slug) AND length(slug) BETWEEN 2 AND 64)
);
--> statement-breakpoint
CREATE INDEX `expertise_profiles_lookup_idx` ON `expertise_profiles` (`organization_id`,`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `expertise_profiles_slug_uq` ON `expertise_profiles` (`organization_id`,`slug`);--> statement-breakpoint
CREATE TABLE `expertise_selections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`task_id` text NOT NULL,
	`employee_id` text,
	`candidates_json` text DEFAULT '[]' NOT NULL,
	`selected_json` text DEFAULT '[]' NOT NULL,
	`signals_json` text DEFAULT '{}' NOT NULL,
	`decided_by` text NOT NULL,
	`model_provider` text,
	`model_name` text,
	`confidence` real,
	`overridden_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `agent_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "expertise_selections_decided_by" CHECK(decided_by IN ('deterministic','model','user')),
	CONSTRAINT "expertise_selections_confidence" CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);
--> statement-breakpoint
CREATE INDEX `expertise_selections_task_idx` ON `expertise_selections` (`organization_id`,`task_id`);