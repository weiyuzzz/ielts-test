CREATE TABLE "answer_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"exam_question_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"audio_asset_id" uuid,
	"wav_asset_id" uuid,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'answered' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_records_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "assessment_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"band" real,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"rationale" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessment_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"answer_id" uuid,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"original_text" text DEFAULT '' NOT NULL,
	"suggestion" text,
	"explanation" text NOT NULL,
	"possible_asr_error" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stage" text,
	"overall_band" real,
	"is_complete" boolean DEFAULT false NOT NULL,
	"scorer" text,
	"llm_provider" text,
	"llm_model" text,
	"prompt_version" text,
	"asr_provider" text,
	"pronunciation_provider" text,
	"metrics" jsonb,
	"notes" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audio_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"duration_ms" integer,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"part" integer NOT NULL,
	"kind" text NOT NULL,
	"question_id" integer,
	"parent_id" uuid,
	"topic" text NOT NULL,
	"examiner_lead" text DEFAULT '' NOT NULL,
	"prompt_text" text NOT NULL,
	"cue_points" jsonb,
	"generator" text DEFAULT 'bank' NOT NULL,
	"prep_seconds" integer DEFAULT 0 NOT NULL,
	"answer_seconds" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"repeat_count" integer DEFAULT 0 NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "exam_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"next_steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_reports_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "exam_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"module" text DEFAULT 'speaking' NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"total_steps" integer DEFAULT 0 NOT NULL,
	"examiner_name" text NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pronunciation_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"answer_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"accuracy" real,
	"fluency" real,
	"prosody" real,
	"completeness" real,
	"overall" real,
	"words" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_sets" (
	"id" serial PRIMARY KEY NOT NULL,
	"module" text DEFAULT 'speaking' NOT NULL,
	"name" text NOT NULL,
	"season" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"set_id" integer NOT NULL,
	"module" text DEFAULT 'speaking' NOT NULL,
	"part" integer NOT NULL,
	"topic" text NOT NULL,
	"topic_key" text NOT NULL,
	"text" text NOT NULL,
	"cue_points" jsonb,
	"order_index" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"answer_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"status" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"words" jsonb,
	"confidence" real,
	"error" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anon_key" text NOT NULL,
	"display_name" text DEFAULT 'Candidate' NOT NULL,
	"target_band" real DEFAULT 7 NOT NULL,
	"exam_date" text,
	"examiner_voice" text DEFAULT 'auto' NOT NULL,
	"show_subtitles" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_anon_key_unique" UNIQUE("anon_key")
);
--> statement-breakpoint
ALTER TABLE "answer_records" ADD CONSTRAINT "answer_records_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_records" ADD CONSTRAINT "answer_records_exam_question_id_exam_questions_id_fk" FOREIGN KEY ("exam_question_id") REFERENCES "public"."exam_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_records" ADD CONSTRAINT "answer_records_audio_asset_id_audio_assets_id_fk" FOREIGN KEY ("audio_asset_id") REFERENCES "public"."audio_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_records" ADD CONSTRAINT "answer_records_wav_asset_id_audio_assets_id_fk" FOREIGN KEY ("wav_asset_id") REFERENCES "public"."audio_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_dimensions" ADD CONSTRAINT "assessment_dimensions_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_findings" ADD CONSTRAINT "assessment_findings_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_findings" ADD CONSTRAINT "assessment_findings_answer_id_answer_records_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answer_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_assets" ADD CONSTRAINT "audio_assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_reports" ADD CONSTRAINT "exam_reports_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_reports" ADD CONSTRAINT "exam_reports_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pronunciation_results" ADD CONSTRAINT "pronunciation_results_answer_id_answer_records_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answer_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_set_id_question_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."question_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_answer_id_answer_records_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answer_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_attempt_uq" ON "answer_records" USING btree ("exam_question_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_dim_uq" ON "assessment_dimensions" USING btree ("assessment_id","dimension");--> statement-breakpoint
CREATE INDEX "assessments_session_idx" ON "assessments" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_questions_step_uq" ON "exam_questions" USING btree ("session_id","step_index");--> statement-breakpoint
CREATE INDEX "exam_sessions_user_idx" ON "exam_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "questions_part_topic_idx" ON "questions" USING btree ("module","part","topic_key");