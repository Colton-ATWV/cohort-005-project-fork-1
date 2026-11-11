ALTER TABLE `refunds` RENAME TO `purchase_cancellation_requests`;--> statement-breakpoint
DROP INDEX `refunds_purchase_idx`;--> statement-breakpoint
CREATE INDEX `purchase_cancellation_requests_purchase_idx` ON `purchase_cancellation_requests` (`purchase_id`);
