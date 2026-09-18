CREATE TABLE `organization_seat_slugs` (
	`slug` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `organization_seat_slugs_org_idx` ON `organization_seat_slugs` (`organization_id`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `seat_slug` text;--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_seat_slug_uq` ON `organizations` (`seat_slug`);