CREATE TABLE `pms_seat_sender_addresses` (
	`organization_id` text NOT NULL,
	`address` text NOT NULL,
	`provider_id` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pms_seat_sender_addresses_uq` ON `pms_seat_sender_addresses` (`organization_id`,`address`);--> statement-breakpoint
CREATE INDEX `pms_seat_sender_addresses_org_idx` ON `pms_seat_sender_addresses` (`organization_id`);--> statement-breakpoint
ALTER TABLE `pms_seat_messages` ADD `authenticated_address` text;