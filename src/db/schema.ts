import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  serial,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Core data model. `module` columns ("speaking" | "listening" | "reading" | "writing")
 * keep the schema ready for the other three IELTS skills without changes.
 */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  anonKey: text("anon_key").notNull().unique(),
  displayName: text("display_name").notNull().default("Candidate"),
  targetBand: real("target_band").notNull().default(7),
  examDate: text("exam_date"),
  examinerVoice: text("examiner_voice").notNull().default("auto"),
  /** Visual examiner identity ("male" | "female"), paired with the voice in settings. */
  examinerGender: text("examiner_gender").notNull().default("female"),
  /** Which examiner look (avatar model id, e.g. "f1"…"f5"/"m1"…"m5"). */
  examinerModel: text("examiner_model"),
  showSubtitles: boolean("show_subtitles").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const questionSets = pgTable("question_sets", {
  id: serial("id").primaryKey(),
  module: text("module").notNull().default("speaking"),
  name: text("name").notNull(),
  /** Season key, e.g. "2026-09-12". Uniqueness is enforced by the import service. */
  season: text("season").notNull(),
  /** Bank region ("Mainland China" | "非大陆地区" legacy | "global") — only banks of the chosen region are used. */
  region: text("region").notNull().default("Mainland China"),
  label: text("label"),
  source: text("source"),
  description: text("description"),
  /** Exactly one bank per module is active: exams strictly draw from it. */
  isActive: boolean("is_active").notNull().default(false),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const questions = pgTable(
  "questions",
  {
    id: serial("id").primaryKey(),
    setId: integer("set_id").notNull().references(() => questionSets.id, { onDelete: "cascade" }),
    module: text("module").notNull().default("speaking"),
    part: integer("part").notNull(),
    topic: text("topic").notNull(),
    /** Topics shared between Part 2 and Part 3 use the same topicKey. */
    topicKey: text("topic_key").notNull(),
    topicZh: text("topic_zh"),
    text: text("text").notNull(),
    textZh: text("text_zh"),
    /** evergreen (Part 1 万年保留题) | new (当季新题) | retained (当季保留题) */
    questionType: text("question_type").notNull().default("retained"),
    /** part1 | part23 | part3 — the bank's own grouping */
    category: text("category").notNull().default("part1"),
    cuePoints: jsonb("cue_points").$type<string[]>(),
    examinees: integer("examinees"),
    /** Optional pre-recorded examiner audio; TTS is used when absent. */
    questionAudioUrl: text("question_audio_url"),
    /**
     * Which voice recorded `question_audio_url` (VoiceProfile id). A recording
     * whose voice cannot be identified must not be assumed to match the
     * examiner, so playback is skipped when this does not match the session.
     */
    questionVoiceProfile: text("question_voice_profile"),
    orderIndex: integer("order_index").notNull().default(0),
  },
  (t) => [index("questions_part_topic_idx").on(t.module, t.part, t.topicKey)],
);

export const examSessions = pgTable(
  "exam_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    module: text("module").notNull().default("speaking"),
    /** full | part1 | part2 | part3 */
    mode: text("mode").notNull(),
    /** in_progress | completed | abandoned */
    status: text("status").notNull().default("in_progress"),
    currentStep: integer("current_step").notNull().default(0),
    totalSteps: integer("total_steps").notNull().default(0),
    examinerName: text("examiner_name").notNull(),
    configSnapshot: jsonb("config_snapshot").$type<Record<string, unknown>>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("exam_sessions_user_idx").on(t.userId, t.startedAt)],
);

export const examQuestions = pgTable(
  "exam_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => examSessions.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    part: integer("part").notNull(),
    /** question | cue_card | follow_up */
    kind: text("kind").notNull(),
    questionId: integer("question_id").references(() => questions.id, { onDelete: "set null" }),
    parentId: uuid("parent_id"),
    topic: text("topic").notNull(),
    /** Examiner lead-in spoken before the prompt (transitions, part intros). */
    examinerLead: text("examiner_lead").notNull().default(""),
    promptText: text("prompt_text").notNull(),
    cuePoints: jsonb("cue_points").$type<string[]>(),
    /** bank | template | llm */
    generator: text("generator").notNull().default("bank"),
    prepSeconds: integer("prep_seconds").notNull().default(0),
    answerSeconds: integer("answer_seconds").notNull(),
    /** pending | answered | skipped */
    status: text("status").notNull().default("pending"),
    repeatCount: integer("repeat_count").notNull().default(0),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("exam_questions_step_uq").on(t.sessionId, t.stepIndex)],
);

export const audioAssets = pgTable("audio_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** recording (browser-native container) | pcm_wav (16 kHz mono for assessment) */
  kind: text("kind").notNull(),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull(),
  bytes: integer("bytes").notNull(),
  durationMs: integer("duration_ms"),
  sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const answerRecords = pgTable(
  "answer_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => examSessions.id, { onDelete: "cascade" }),
    examQuestionId: uuid("exam_question_id").notNull().references(() => examQuestions.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    audioAssetId: uuid("audio_asset_id").references(() => audioAssets.id, { onDelete: "set null" }),
    wavAssetId: uuid("wav_asset_id").references(() => audioAssets.id, { onDelete: "set null" }),
    durationMs: integer("duration_ms").notNull().default(0),
    /** answered | no_response */
    status: text("status").notNull().default("answered"),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("answer_attempt_uq").on(t.examQuestionId, t.attempt)],
);

export type WordTiming = { word: string; start: number; end: number; confidence?: number };

export const transcripts = pgTable("transcripts", {
  id: uuid("id").primaryKey().defaultRandom(),
  answerId: uuid("answer_id").notNull().references(() => answerRecords.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  model: text("model"),
  /** pending | completed | failed | unavailable */
  status: text("status").notNull(),
  text: text("text").notNull().default(""),
  words: jsonb("words").$type<WordTiming[]>(),
  confidence: real("confidence"),
  error: text("error"),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pronunciationResults = pgTable("pronunciation_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  answerId: uuid("answer_id").notNull().references(() => answerRecords.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  accuracy: real("accuracy"),
  fluency: real("fluency"),
  prosody: real("prosody"),
  completeness: real("completeness"),
  overall: real("overall"),
  words: jsonb("words").$type<{ word: string; accuracy: number; errorType?: string }[]>(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assessments = pgTable(
  "assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => examSessions.id, { onDelete: "cascade" }),
    /** pending | running | completed | partial | failed */
    status: text("status").notNull().default("pending"),
    stage: text("stage"),
    overallBand: real("overall_band"),
    isComplete: boolean("is_complete").notNull().default(false),
    /** llm | heuristic */
    scorer: text("scorer"),
    llmProvider: text("llm_provider"),
    llmModel: text("llm_model"),
    promptVersion: text("prompt_version"),
    asrProvider: text("asr_provider"),
    pronunciationProvider: text("pronunciation_provider"),
    metrics: jsonb("metrics").$type<Record<string, unknown>>(),
    /**
     * Whole-exam audio analysis (see src/lib/speaking/audio-analysis.ts).
     * Null for assessments scored before audio analysis existed — the report
     * treats absence as "not analysed", never as zeros.
     */
    audioAnalysis: jsonb("audio_analysis").$type<Record<string, unknown>>(),
    /** Which rubric revision produced this assessment (see band-descriptors.ts). */
    rubricVersion: text("rubric_version"),
    /** Model-stated limitations (evidence gaps, audio quality, ASR errors…). */
    limitations: jsonb("limitations").$type<string[]>(),
    notes: jsonb("notes").$type<string[]>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("assessments_session_idx").on(t.sessionId)],
);

export const assessmentDimensions = pgTable(
  "assessment_dimensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
    /** FC | LR | GRA | P */
    dimension: text("dimension").notNull(),
    band: real("band"),
    /** scored | not_assessed */
    status: text("status").notNull(),
    source: text("source").notNull(),
    rationale: text("rationale").notNull(),
    /**
     * Rubric descriptor ids the scorer cited for THIS band (validated before
     * insert). Null for rows written before the column existed.
     */
    descriptorRefs: jsonb("descriptor_refs").$type<string[]>().notNull().default([]),
    /**
     * Model's evidence-sufficiency judgement for this band (0–1), NOT an IELTS
     * band and not an accuracy claim. Null for rows scored before the field
     * existed or when the model did not supply one.
     */
    confidence: real("confidence"),
    /** What the candidate did well per the rubric (validated strings, capped). */
    strengths: jsonb("strengths").$type<string[]>().notNull().default([]),
    /** What held the band down per the rubric (validated strings, capped). */
    weaknesses: jsonb("weaknesses").$type<string[]>().notNull().default([]),
  },
  (t) => [uniqueIndex("assessment_dim_uq").on(t.assessmentId, t.dimension)],
);

export const audioAnalyses = pgTable(
  "audio_analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    answerId: uuid("answer_id").notNull().references(() => answerRecords.id, { onDelete: "cascade" }),
    /** audio-analysis-vN — the producing module version. */
    version: text("version").notNull(),
    /** completed | failed */
    status: text("status").notNull(),
    analysis: jsonb("analysis").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audio_analyses_answer_idx").on(t.answerId)],
);

export const assessmentFindings = pgTable("assessment_findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
  dimension: text("dimension").notNull(),
  answerId: uuid("answer_id").references(() => answerRecords.id, { onDelete: "set null" }),
  /** error | strength | issue */
  kind: text("kind").notNull(),
  category: text("category").notNull(),
  originalText: text("original_text").notNull().default(""),
  suggestion: text("suggestion"),
  explanation: text("explanation").notNull(),
  possibleAsrError: boolean("possible_asr_error").notNull().default(false),
  /**
   * Rubric descriptor ids this finding is evidence for, e.g. ["GRA-B6-02"].
   * Ids are validated against the rubric before insert; older rows default to [].
   */
  descriptorRefs: jsonb("descriptor_refs").$type<string[]>().notNull().default([]),
  /**
   * Where this evidence lives: transcript (quote), audio (a located segment)
   * or metric (aggregate statistics). Older rows default to "transcript".
   */
  evidenceType: text("evidence_type").notNull().default("transcript"),
  /** Inclusive audio-clip bounds in ms (answer-relative); null = not locatable. */
  startMs: integer("start_ms"),
  endMs: integer("end_ms"),
});

export const examReports = pgTable("exam_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().unique().references(() => examSessions.id, { onDelete: "cascade" }),
  assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  nextSteps: jsonb("next_steps").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per outbound AI call (scoring / ASR / TTS / pronunciation) — the
 * consumption ledger behind the /admin usage panel. Bookkeeping is
 * best-effort and never blocks an AI call.
 */
export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** llm | asr | tts | pronunciation */
    service: text("service").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    /** ok | failed */
    status: text("status").notNull(),
    latencyMs: integer("latency_ms"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    /** Service units: ASR = audio ms, TTS = characters, pronunciation = sessions. */
    units: integer("units"),
    unitLabel: text("unit_label"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_usage_service_created_idx").on(t.service, t.createdAt)],
);
