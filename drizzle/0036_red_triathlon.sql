CREATE TABLE `pms_seat_messages` (
	`digest` text PRIMARY KEY NOT NULL,
	`recipient` text NOT NULL,
	`organization_id` text,
	`disposition` text NOT NULL,
	`authenticated_domain` text,
	`method` text,
	`provider_id` text,
	`reason` text,
	`observed_authserv_ids` text,
	`object_key` text NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pms_seat_messages_org_idx` ON `pms_seat_messages` (`organization_id`,`disposition`);--> statement-breakpoint
CREATE INDEX `pms_seat_messages_held_idx` ON `pms_seat_messages` (`organization_id`,`authenticated_domain`);