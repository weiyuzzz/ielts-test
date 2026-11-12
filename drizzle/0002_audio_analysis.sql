CREATE TABLE "audio_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"answer_id" uuid NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"analysis" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessment_dimensions" ADD COLUMN "descriptor_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "audio_analysis" jsonb;--> statement-breakpoint
ALTER TABLE "audio_analyses" ADD CONSTRAINT "audio_analyses_answer_id_answer_records_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answer_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_analyses_answer_idx" ON "audio_analyses" USING btree ("answer_id");