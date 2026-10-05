CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`action_id` text NOT NULL,
	`action_type` text NOT NULL,
	`relationship_action` text,
	`sent` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `approvals_business_created_idx` ON `approvals` (`business_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`action_id` text NOT NULL,
	`action_type` text NOT NULL,
	`outcome_type` text NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outcomes_business_created_idx` ON `outcomes` (`business_id`,`created_at`);