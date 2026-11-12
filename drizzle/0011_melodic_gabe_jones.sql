CREATE TABLE `refund_payment_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_id` integer NOT NULL,
	`status` text NOT NULL,
	`actor_user_id` integer NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `refund_payment_events_refund_idx` ON `refund_payment_events` (`refund_id`);--> statement-breakpoint
ALTER TABLE `enrollments` ADD `access_revoked_at` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `decision_explanation` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `payment_status` text;
--> statement-breakpoint
UPDATE `refunds` SET `payment_status` = 'pending' WHERE `status` = 'approved';
