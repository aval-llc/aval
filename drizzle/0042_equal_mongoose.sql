CREATE TABLE `ai_employee_scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`scope_kind` text NOT NULL,
	`value` text NOT NULL,
	`granted_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `ai_employees`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_employee_scopes_kind" CHECK(scope_kind IN ('property','connection','capability','work_type','data_domain','delegate_to')),
	CONSTRAINT "ai_employee_scopes_value_present" CHECK(length(trim(value)) > 0)
);
--> statement-breakpoint
CREATE INDEX `ai_employee_scopes_lookup_idx` ON `ai_employee_scopes` (`employee_id`,`scope_kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_employee_scopes_grant_uq` ON `ai_employee_scopes` (`employee_id`,`scope_kind`,`value`);--> statement-breakpoint
CREATE TABLE `ai_employees` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`description` text,
	`objective` text,
	`instructions` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`autonomy_mode` text DEFAULT 'supervised' NOT NULL,
	`approval_policy` text DEFAULT 'standard' NOT NULL,
	`spend_limit_cents` integer,
	`risk_ceiling` text DEFAULT 'low' NOT NULL,
	`memory_scope` text DEFAULT 'work' NOT NULL,
	`may_communicate_externally` integer DEFAULT false NOT NULL,
	`may_delegate` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_employees_status" CHECK(status IN ('draft','active','paused','archived')),
	CONSTRAINT "ai_employees_autonomy" CHECK(autonomy_mode IN ('supervised','assisted','autonomous')),
	CONSTRAINT "ai_employees_risk" CHECK(risk_ceiling IN ('low','medium','high','critical')),
	CONSTRAINT "ai_employees_memory_scope" CHECK(memory_scope IN ('organization','property','work')),
	CONSTRAINT "ai_employees_spend_nonnegative" CHECK(spend_limit_cents IS NULL OR spend_limit_cents >= 0),
	CONSTRAINT "ai_employees_name_present" CHECK(length(trim(name)) > 0),
	CONSTRAINT "ai_employees_role_present" CHECK(length(trim(role)) > 0)
);
--> statement-breakpoint
CREATE INDEX `ai_employees_org_idx` ON `ai_employees` (`organization_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_employees_org_name_uq` ON `ai_employees` (`organization_id`,`name`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `ai_employee_limit` integer;