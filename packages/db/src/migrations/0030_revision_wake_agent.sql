ALTER TABLE "approvals" ADD COLUMN "revision_wake_agent_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvals" ADD CONSTRAINT "approvals_revision_wake_agent_id_agents_id_fk" FOREIGN KEY ("revision_wake_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
