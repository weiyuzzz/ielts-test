ALTER TABLE "assessment_dimensions" ADD COLUMN "confidence" real;--> statement-breakpoint
ALTER TABLE "assessment_dimensions" ADD COLUMN "strengths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_dimensions" ADD COLUMN "weaknesses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_findings" ADD COLUMN "evidence_type" text DEFAULT 'transcript' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_findings" ADD COLUMN "start_ms" integer;--> statement-breakpoint
ALTER TABLE "assessment_findings" ADD COLUMN "end_ms" integer;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "rubric_version" text;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "limitations" jsonb;