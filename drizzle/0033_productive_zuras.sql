CREATE TABLE `pms_action_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`action` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`steps_json` text NOT NULL,
	`digest` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`learned_by_user_id` text,
	`last_replay_at` integer,
	`last_replay_ok` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pms_action_flow_uq` ON `pms_action_flows` (`organization_id`,`provider`,`action`,`version`);--> statement-breakpoint
CREATE INDEX `pms_action_flow_lookup_idx` ON `pms_action_flows` (`organization_id`,`provider`,`action`,`status`);--> statement-breakpoint
CREATE TABLE `pms_write_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`action` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`signed_authorization` integer DEFAULT false NOT NULL,
	`authorization_reference` text,
	`version` integer DEFAULT 1 NOT NULL,
	`approved_by_user_id` text,
	`approved_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pms_write_auth_uq` ON `pms_write_authorizations` (`organization_id`,`provider`,`action`);--> statement-breakpoint
CREATE INDEX `pms_write_auth_org_idx` ON `pms_write_authorizations` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `pms_write_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`action` text NOT NULL,
	`approval_id` text,
	`flow_id` text,
	`payload_json` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`leased_by` text,
	`lease_expires_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pms_write_queue_idem_uq` ON `pms_write_queue` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `pms_write_queue_drain_idx` ON `pms_write_queue` (`organization_id`,`status`,`created_at`);