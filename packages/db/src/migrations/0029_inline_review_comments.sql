ALTER TABLE "approval_comments" ADD COLUMN "file_path" text;--> statement-breakpoint
ALTER TABLE "approval_comments" ADD COLUMN "line_number" integer;--> statement-breakpoint
ALTER TABLE "approval_comments" ADD COLUMN "side" text;--> statement-breakpoint
CREATE INDEX "approval_comments_approval_file_line_idx" ON "approval_comments" USING btree ("approval_id","file_path","line_number");
