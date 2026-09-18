CREATE TABLE `access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`role` text NOT NULL,
	`organization_scope` integer DEFAULT false NOT NULL,
	`ownership_entity_id` text,
	`portfolio_id` text,
	`region_id` text,
	`property_id` text,
	`capabilities_json` text DEFAULT '[]' NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`created_by_principal_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ownership_entity_id`) REFERENCES `ownership_entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`region_id`) REFERENCES `regions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`ownership_entity_id`) REFERENCES `ownership_entities`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`portfolio_id`) REFERENCES `portfolios`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`region_id`) REFERENCES `regions`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`property_id`) REFERENCES `properties`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "access_grants_role_ck" CHECK("access_grants"."role" in ('org_admin','regional_manager','property_manager','approver','operator','viewer','owner_viewer')),
	CONSTRAINT "access_grants_one_scope_ck" CHECK(
    (case when "access_grants"."organization_scope" then 1 else 0 end) +
    (case when "access_grants"."ownership_entity_id" is not null then 1 else 0 end) +
    (case when "access_grants"."portfolio_id" is not null then 1 else 0 end) +
    (case when "access_grants"."region_id" is not null then 1 else 0 end) +
    (case when "access_grants"."property_id" is not null then 1 else 0 end) = 1
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_grants_org_id_uq` ON `access_grants` (`organization_id`,`id`);--> statement-breakpoint
CREATE INDEX `access_grants_principal_org_idx` ON `access_grants` (`principal_id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `access_grants_property_idx` ON `access_grants` (`organization_id`,`property_id`);--> statement-breakpoint
CREATE TABLE `approval_authorities` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`access_grant_id` text NOT NULL,
	`action` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`maximum_amount_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`access_grant_id`) REFERENCES `access_grants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`access_grant_id`) REFERENCES `access_grants`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approval_authorities_amount_ck" CHECK("approval_authorities"."maximum_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_authorities_grant_action_currency_uq` ON `approval_authorities` (`access_grant_id`,`action`,`currency`);--> statement-breakpoint
CREATE TABLE `identity_links` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`email_at_link` text,
	`email_verified` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_links_provider_subject_uq` ON `identity_links` (`provider`,`subject`);--> statement-breakpoint
CREATE INDEX `identity_links_principal_idx` ON `identity_links` (`principal_id`);--> statement-breakpoint
CREATE TABLE `ownership_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`legal_name` text,
	`external_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ownership_entities_org_id_uq` ON `ownership_entities` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ownership_entities_org_external_uq` ON `ownership_entities` (`organization_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `portfolios` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolios_org_id_uq` ON `portfolios` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `portfolios_org_name_uq` ON `portfolios` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE `principals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'human' NOT NULL,
	`display_name` text NOT NULL,
	`primary_email` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "principals_kind_ck" CHECK("principals"."kind" in ('human','service'))
);
--> statement-breakpoint
CREATE TABLE `regions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `regions_org_id_uq` ON `regions` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `regions_org_code_uq` ON `regions` (`organization_id`,`code`);--> statement-breakpoint
CREATE TABLE `sso_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`supabase_provider_id` text,
	`permitted_domains_json` text DEFAULT '[]' NOT NULL,
	`enforcement` text DEFAULT 'disabled' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sso_connections_enforcement_ck" CHECK("sso_connections"."enforcement" in ('disabled','optional','required'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_connections_org_uq` ON `sso_connections` (`organization_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_properties` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`ownership_entity_id` text,
	`portfolio_id` text,
	`region_id` text,
	`name` text NOT NULL,
	`address_line1` text,
	`city` text,
	`region` text,
	`postal_code` text,
	`country` text DEFAULT 'US' NOT NULL,
	`property_type` text DEFAULT 'multifamily' NOT NULL,
	`reported_unit_count` integer,
	`year_built` integer,
	`square_feet` integer,
	`acquisition_cost_cents` integer,
	`current_value_cents` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`source_provider` text DEFAULT 'manual' NOT NULL,
	`source_connection_id` text,
	`external_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ownership_entity_id`) REFERENCES `ownership_entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`region_id`) REFERENCES `regions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`ownership_entity_id`) REFERENCES `ownership_entities`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`portfolio_id`) REFERENCES `portfolios`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`region_id`) REFERENCES `regions`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_properties`("id", "organization_id", "ownership_entity_id", "portfolio_id", "region_id", "name", "address_line1", "city", "region", "postal_code", "country", "property_type", "reported_unit_count", "year_built", "square_feet", "acquisition_cost_cents", "current_value_cents", "status", "source_provider", "source_connection_id", "external_id", "created_at", "updated_at") SELECT "id", "organization_id", NULL, NULL, NULL, "name", "address_line1", "city", "region", "postal_code", "country", "property_type", "reported_unit_count", "year_built", "square_feet", "acquisition_cost_cents", "current_value_cents", "status", "source_provider", "source_connection_id", "external_id", "created_at", "updated_at" FROM `properties`;--> statement-breakpoint
DROP TABLE `properties`;--> statement-breakpoint
ALTER TABLE `__new_properties` RENAME TO `properties`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `properties_org_id_uq` ON `properties` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `properties_org_source_external_uq` ON `properties` (`organization_id`,`source_provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `properties_org_status_idx` ON `properties` (`organization_id`,`status`);
