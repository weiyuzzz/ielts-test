CREATE TABLE "ai_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"status" text NOT NULL,
	"latency_ms" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"units" integer,
	"unit_label" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ai_usage_service_created_idx" ON "ai_usage_events" USING btree ("service","created_at");