ALTER TABLE "bots" ADD COLUMN "transcription" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "transcription_status" varchar(255) DEFAULT 'PENDING';