-- Part 1 gate-question branching: a topic can open with a gate question whose
-- answer steers which sub-bank ("student" | "work") the follow-ups draw from.
-- NOTE: examiner_gender / examiner_model (added in 0004) and digital_human_3d
-- (added in 0006) were hand-written migrations whose meta snapshots were not
-- updated, so drizzle-kit generate re-emitted them here. They are removed from
-- this file — do not re-add them without updating the meta snapshots.
ALTER TABLE "question_sets" ALTER COLUMN "region" SET DEFAULT 'Mainland China';--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "question_role" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "audience" text;
