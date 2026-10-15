CREATE TABLE "email_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" integer NOT NULL,
	"subject" varchar(998) NOT NULL,
	"body" text NOT NULL,
	"startAt" timestamp with time zone NOT NULL,
	"delayMs" integer NOT NULL,
	"hourlyLimit" integer NOT NULL,
	"totalEmails" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batchId" uuid NOT NULL,
	"recipient" varchar(320) NOT NULL,
	"subject" varchar(998) NOT NULL,
	"body" text NOT NULL,
	"scheduledAt" timestamp with time zone NOT NULL,
	"status" varchar(20) DEFAULT 'scheduled' NOT NULL,
	"idempotencyKey" varchar(255) NOT NULL,
	"sentAt" timestamp with time zone,
	"providerMessageId" varchar(255),
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emails_idempotencyKey_unique" UNIQUE("idempotencyKey")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eventType" varchar(100) NOT NULL,
	"aggregateType" varchar(100) NOT NULL,
	"aggregateId" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"availableAt" timestamp with time zone DEFAULT now() NOT NULL,
	"processedAt" timestamp with time zone,
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_batches" ADD CONSTRAINT "email_batches_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_batchId_email_batches_id_fk" FOREIGN KEY ("batchId") REFERENCES "public"."email_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_batches_user_created_idx" ON "email_batches" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "emails_batch_idx" ON "emails" USING btree ("batchId");--> statement-breakpoint
CREATE INDEX "emails_status_scheduled_idx" ON "emails" USING btree ("status","scheduledAt");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("status","availableAt");