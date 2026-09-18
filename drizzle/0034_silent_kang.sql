CREATE TABLE `agent_deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`persona_id` text NOT NULL,
	`provider` text NOT NULL,
	`workflows_json` text DEFAULT '[]' NOT NULL,
	`autonomy_mode` text DEFAULT 'supervised' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_deployments_uq` ON `agent_deployments` (`organization_id`,`persona_id`,`provider`);--> statement-breakpoint
CREATE INDEX `agent_deployments_lookup_idx` ON `agent_deployments` (`organization_id`,`persona_id`,`status`);