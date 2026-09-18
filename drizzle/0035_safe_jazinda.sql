CREATE TABLE `pms_seat_senders` (
	`organization_id` text NOT NULL,
	`domain` text NOT NULL,
	`provider_id` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pms_seat_senders_uq` ON `pms_seat_senders` (`organization_id`,`domain`);--> statement-breakpoint
CREATE INDEX `pms_seat_senders_org_idx` ON `pms_seat_senders` (`organization_id`);