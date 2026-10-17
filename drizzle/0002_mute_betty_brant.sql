CREATE TABLE "send_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"emailId" uuid NOT NULL,
	"attemptNumber" integer NOT NULL,
	"status" varchar(20) NOT NULL,
	"providerMessageId" varchar(255),
	"error" text,
	"attemptedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "send_attempts_email_attempt_unique" UNIQUE("emailId","attemptNumber")
);
--> statement-breakpoint
CREATE TABLE "senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" integer NOT NULL,
	"fromName" varchar(255) NOT NULL,
	"fromEmail" varchar(320) NOT NULL,
	"hourlyLimit" integer NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"slackWebhookUrl" varchar(500),
	"slackConnectedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "senders_user_from_email_unique" UNIQUE("userId","fromEmail")
);
--> statement-breakpoint
ALTER TABLE "email_batches" ADD COLUMN "senderId" uuid;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "senderId" uuid;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_emailId_emails_id_fk" FOREIGN KEY ("emailId") REFERENCES "public"."emails"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "senders" ADD CONSTRAINT "senders_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "send_attempts_email_idx" ON "send_attempts" USING btree ("emailId");--> statement-breakpoint
CREATE INDEX "senders_user_idx" ON "senders" USING btree ("userId");--> statement-breakpoint
ALTER TABLE "email_batches" ADD CONSTRAINT "email_batches_senderId_senders_id_fk" FOREIGN KEY ("senderId") REFERENCES "public"."senders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_senderId_senders_id_fk" FOREIGN KEY ("senderId") REFERENCES "public"."senders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "emails_sender_idx" ON "emails" USING btree ("senderId");