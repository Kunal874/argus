CREATE TABLE `analysis_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`report_date` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `analysis_snapshots_business_created_idx` ON `analysis_snapshots` (`business_id`,`created_at`);