PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pms_action_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`provider` text NOT NULL,
	`action` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`access_mode` text DEFAULT 'customer_desktop_session' NOT NULL,
	`steps_json` text NOT NULL,
	`digest` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`required_role` text,
	`risk_class` text DEFAULT 'medium' NOT NULL,
	`verification_strategy` text DEFAULT 'read_after_write' NOT NULL,
	`reconciliation_strategy` text DEFAULT 'field_match' NOT NULL,
	`fallback` text DEFAULT 'human_handoff' NOT NULL,
	`certification` text DEFAULT 'unimplemented' NOT NULL,
	`learned_by_user_id` text,
	`promoted_by_user_id` text,
	`promoted_at` integer,
	`last_replay_at` integer,
	`last_replay_ok` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`known_issues` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_pms_action_flows`("id", "organization_id", "provider", "action", "version", "access_mode", "steps_json", "digest", "status", "required_role", "risk_class", "verification_strategy", "reconciliation_strategy", "fallback", "certification", "learned_by_user_id", "promoted_by_user_id", "promoted_at", "last_replay_at", "last_replay_ok", "consecutive_failures", "known_issues", "created_at", "updated_at") SELECT "id", "organization_id", "provider", "action", "version", 'customer_desktop_session', "steps_json", "digest", CASE "status" WHEN 'candidate' THEN 'draft' WHEN 'retired' THEN 'disabled' ELSE "status" END, NULL, 'medium', 'read_after_write', 'field_match', 'human_handoff', 'unimplemented', "learned_by_user_id", NULL, NULL, "last_replay_at", "last_replay_ok", "consecutive_failures", NULL, "created_at", "updated_at" FROM `pms_action_flows`;--> statement-breakpoint
DROP TABLE `pms_action_flows`;--> statement-breakpoint
ALTER TABLE `__new_pms_action_flows` RENAME TO `pms_action_flows`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `pms_action_flow_uq` ON `pms_action_flows` (`organization_id`,`provider`,`action`,`version`);--> statement-breakpoint
CREATE INDEX `pms_action_flow_lookup_idx` ON `pms_action_flows` (`organization_id`,`provider`,`action`,`status`);