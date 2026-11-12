ALTER TABLE "question_sets" ALTER COLUMN "is_active" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "assessment_findings" ADD COLUMN "descriptor_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "question_sets" ADD COLUMN "region" text DEFAULT '大陆地区' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_sets" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "question_sets" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "question_sets" ADD COLUMN "imported_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "topic_zh" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "text_zh" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "question_type" text DEFAULT 'retained' NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "category" text DEFAULT 'part1' NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "examinees" integer;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "question_audio_url" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "question_voice_profile" text;