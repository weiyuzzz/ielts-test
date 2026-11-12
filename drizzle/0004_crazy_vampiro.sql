ALTER TABLE "question_sets" ALTER COLUMN "region" SET DEFAULT 'Mainland China';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "examiner_gender" text DEFAULT 'female' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "examiner_model" text;