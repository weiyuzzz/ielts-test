/**
 * IELTS Speaking assessment criteria + a structured 0–9 band rubric.
 *
 * Four independent criteria, each worth 25%, scored 0–9 (half bands allowed).
 * The official *public version* band descriptors are prose tables; the wording
 * below is a **structured paraphrase** written for machine judgement, not the
 * official text. It is NOT an official score guarantee.
 *
 * Every criterion is described at INTEGER bands only, exactly like the official
 * descriptors. There is no official "6.5" wording: a half band means the
 * performance sits between two adjacent integer bands, and the scorer must pick
 * the closer one and cite descriptors from the bands it straddles.
 *
 * IDs are stable and self-describing: `<DIM>-B<band>-<nn>` (e.g. `FC-B7-01`).
 * Do not renumber existing IDs — reports and findings reference them.
 */
export type CriterionKey = "FC" | "LR" | "GRA" | "P";

export interface Criterion {
  key: CriterionKey;
  label: string;
  /** Short key indicators (kept for the report's "评分依据" summary line). */
  indicators: string[];
}

export interface BandDescriptor {
  /** Stable unique id, e.g. `GRA-B6-01`. */
  id: string;
  dimension: CriterionKey;
  /** Integer band 0–9. */
  band: number;
  /** Concise, judgeable criterion (paraphrase). */
  text: string;
  /** Short tag for grouping in the UI. */
  focus: string;
}

/** Provenance. Kept next to the data so a rubric change is auditable. */
export const DESCRIPTOR_SOURCE = {
  title: "IELTS Speaking band descriptors (public version)",
  publisher: "British Council / IELTS Partners",
  url: "https://takeielts.britishcouncil.org/take-ielts/ielts-results-scores",
  retrieved: "2026-11-13",
  /** Internal rubric revision, bumped whenever any descriptor text changes. */
  revision: "rubric-1.0",
  note:
    "Structured paraphrase for diagnostic practice feedback. Not the official wording, " +
    "not an official IELTS score, and not affiliated with or endorsed by the IELTS Partners.",
} as const;

export const BAND_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

// ------------------------------------------------------------------ criteria
export const CRITERIA: Criterion[] = [
  {
    key: "FC", label: "Fluency & Coherence",
    indicators: [
      "Speech rate: not slow; maintains linking between words and clauses",
      "Continuity of delivery: avoids repeated false starts, backtracking, meaningless repetition and frequent word-search pauses",
      "Coherence: logical sequencing of sentences, structural markers (appropriate pausing and discourse markers), relevance of content, and cohesive devices (connectives / pronouns / conjunctions)",
    ],
  },
  {
    key: "LR", label: "Lexical Resource",
    indicators: [
      "Vocabulary range, sufficiency and appropriacy (adequacy & appropriacy)",
      "Accurate referential meaning; register (formal / informal) appropriate to the context",
      "Natural collocation and idiom; can express attitudes such as agreement, neutrality and disagreement",
      "Paraphrase ability (can rephrase when the exact word is unavailable)",
    ],
  },
  {
    key: "GRA", label: "Grammatical Range & Accuracy",
    indicators: [
      "Range: sentence length, clauses, verb-phrase complexity (progressive / perfect / modal / passive), pre- and post-modification of phrases, variety of sentence patterns",
      "Accuracy: error density (per hundred words) and the communicative impact of errors (whether they affect understanding and clarity)",
      "The goal is fewer errors, not piling up complex structures",
    ],
  },
  {
    key: "P", label: "Pronunciation",
    indicators: [
      "Chunking: dividing speech into meaningful units",
      "Rhythm and stress; connected speech (linking / weak forms / elision)",
      "Stress and intonation (emphasis, contrast)",
      "Accurate phonemes, word stress, and vowel and consonant production",
      "Effort required for the listener to understand; accent intelligibility — pronunciation is not accent, and no national accent is penalised",
    ],
  },
];

/** Part-specific expectations (Simon notes): an answer that is "short" is correct in Part 1. */
export const PART_RULES: Record<number, string> = {
  1: "Part 1 (4–5 minutes, 10–11 short questions): fluency. Short, quick and direct — one full sentence plus one reason is enough; a short answer is the correct strategy and is never penalised, nor is a long one rewarded.",
  2: "Part 2 (1 minute preparation + 2 minute monologue): vocabulary and ideas. Develop the topic — person/place/object/event/activity/favourite — with detail and examples; structural complexity or fancy grammar is not the main scoring point.",
  3: "Part 3 (3–6 questions): long, developed answers with structure (direct answer → explain why → give an example → consider the opposite/alternative), emphasising logical development and a clear point of view.",
};

export const WEIGHT_RULE = "Four independently scored criteria, 25% each, bands 0–9 in half bands; the overall band follows the IELTS rounding rule (.25 rounds up to .5, .75 rounds up to a whole band). A missing dimension must be marked as not assessed — never filled with a placeholder score.";

// ------------------------------------------------------------------ rubric seeds
type Seed = { band: number; items: { text: string; focus: string }[] };

const SEEDS: Record<CriterionKey, Seed[]> = {
  FC: [
    { band: 9, items: [
      { text: "Speaks with only rare repetition or self-correction; any hesitation reflects thinking about content, not searching for words or grammar.", focus: "fluency" },
      { text: "Develops topics fully and coherently, using cohesive devices that are always appropriate to the message.", focus: "cohesion" },
    ] },
    { band: 8, items: [
      { text: "Speaks fluently with only occasional repetition or self-correction; hesitation is mostly content-related and rarely about language.", focus: "fluency" },
      { text: "Develops topics coherently and appropriately; linking is natural rather than mechanical.", focus: "cohesion" },
    ] },
    { band: 7, items: [
      { text: "Can speak at length without noticeable effort and without losing overall coherence.", focus: "fluency" },
      { text: "Occasional language-related hesitation, repetition or self-correction may appear but does not derail the answer.", focus: "fluency" },
      { text: "Uses a range of connectives and discourse markers with some flexibility, not just a fixed list.", focus: "cohesion" },
    ] },
    { band: 6, items: [
      { text: "Is willing to speak at length, though coherence may occasionally break down because of repetition, self-correction or hesitation.", focus: "fluency" },
      { text: "Uses a range of connectives and discourse markers, but not always appropriately or accurately.", focus: "cohesion" },
    ] },
    { band: 5, items: [
      { text: "Usually keeps going, but relies on repetition, self-correction or slower speech to maintain flow.", focus: "fluency" },
      { text: "May overuse a small set of connectives and discourse markers instead of selecting them for meaning.", focus: "cohesion" },
      { text: "Simple speech is fairly fluent, but complex communication causes noticeable fluency problems.", focus: "fluency" },
    ] },
    { band: 4, items: [
      { text: "Cannot respond without noticeable pauses and may speak slowly, with frequent repetition and self-correction.", focus: "fluency" },
      { text: "Links basic sentences but with repetitive use of simple connectives, and coherence breaks down in places.", focus: "cohesion" },
    ] },
    { band: 3, items: [
      { text: "Can talk about familiar topics, but on unfamiliar topics can convey only basic meaning.", focus: "fluency" },
      { text: "Rarely attempts to link ideas within or across sentences; struggles to continue without noticeable pauses or restarts.", focus: "cohesion" },
    ] },
    { band: 2, items: [
      { text: "Pauses at length before most words; very little communication is possible.", focus: "fluency" },
    ] },
    { band: 1, items: [
      { text: "No connected speech that can be assessed.", focus: "fluency" },
    ] },
    { band: 0, items: [
      { text: "Does not attend, or produces no assessable language.", focus: "fluency" },
    ] },
  ],
  LR: [
    { band: 9, items: [
      { text: "Uses a full range of vocabulary flexibly and precisely across topics.", focus: "range" },
      { text: "Shows natural, sophisticated control of collocation, register and nuance; only minor slips.", focus: "appropriacy" },
    ] },
    { band: 8, items: [
      { text: "Has a wide vocabulary resource and accesses it readily and flexibly.", focus: "range" },
      { text: "Uses less common and idiomatic vocabulary skilfully, with only occasional inaccuracy.", focus: "appropriacy" },
      { text: "Paraphrases effectively when the precise word is unavailable.", focus: "paraphrase" },
    ] },
    { band: 7, items: [
      { text: "Vocabulary is flexible enough to discuss a variety of topics at length.", focus: "range" },
      { text: "Uses some less common and idiomatic items and shows awareness of style and collocation, with some inappropriate choices.", focus: "appropriacy" },
      { text: "Paraphrases successfully when needed.", focus: "paraphrase" },
    ] },
    { band: 6, items: [
      { text: "Has a wide enough vocabulary to discuss topics at length and make meaning clear despite inappropriacies.", focus: "range" },
      { text: "Generally paraphrases successfully, though not always precisely.", focus: "paraphrase" },
    ] },
    { band: 5, items: [
      { text: "Can talk about familiar and unfamiliar topics, but vocabulary use is limited in flexibility.", focus: "range" },
      { text: "Attempts paraphrase with mixed success.", focus: "paraphrase" },
    ] },
    { band: 4, items: [
      { text: "Manages familiar topics but conveys only basic meaning on unfamiliar ones.", focus: "range" },
      { text: "Makes frequent errors in word choice and rarely attempts paraphrase.", focus: "appropriacy" },
    ] },
    { band: 3, items: [
      { text: "Uses simple vocabulary to convey personal information; vocabulary is insufficient for less familiar topics.", focus: "range" },
    ] },
    { band: 2, items: [
      { text: "Produces only isolated words or memorised utterances.", focus: "range" },
    ] },
    { band: 1, items: [
      { text: "No vocabulary that can be assessed.", focus: "range" },
    ] },
    { band: 0, items: [
      { text: "Does not attend, or produces no assessable language.", focus: "range" },
    ] },
  ],
  GRA: [
    { band: 9, items: [
      { text: "Uses a full range of structures naturally and appropriately.", focus: "range" },
      { text: "Produces consistently accurate structures apart from native-speaker-style slips.", focus: "accuracy" },
    ] },
    { band: 8, items: [
      { text: "Uses a wide range of structures flexibly.", focus: "range" },
      { text: "Most sentences are error-free; only very occasional inappropriacies or non-systematic errors.", focus: "accuracy" },
    ] },
    { band: 7, items: [
      { text: "Uses a range of complex structures with some flexibility.", focus: "range" },
      { text: "Frequently produces error-free sentences, though some grammatical mistakes persist.", focus: "accuracy" },
    ] },
    { band: 6, items: [
      { text: "Mixes simple and complex structures, but with limited flexibility.", focus: "range" },
      { text: "Complex structures attract frequent errors, which rarely cause comprehension problems.", focus: "accuracy" },
    ] },
    { band: 5, items: [
      { text: "Produces basic sentence forms with reasonable accuracy.", focus: "accuracy" },
      { text: "Uses a limited range of complex structures; these usually contain errors and may cause some comprehension difficulty.", focus: "range" },
    ] },
    { band: 4, items: [
      { text: "Produces basic sentence forms and some correct simple sentences; subordinate structures are rare.", focus: "range" },
      { text: "Errors are frequent and may lead to misunderstanding.", focus: "accuracy" },
    ] },
    { band: 3, items: [
      { text: "Attempts basic sentence forms with limited success, or relies on apparently memorised utterances.", focus: "range" },
      { text: "Makes numerous errors except in memorised expressions.", focus: "accuracy" },
    ] },
    { band: 2, items: [
      { text: "Cannot produce basic sentence forms.", focus: "accuracy" },
    ] },
    { band: 1, items: [
      { text: "No grammar that can be assessed.", focus: "accuracy" },
    ] },
    { band: 0, items: [
      { text: "Does not attend, or produces no assessable language.", focus: "accuracy" },
    ] },
  ],
  P: [
    { band: 9, items: [
      { text: "Uses the full range of pronunciation features with precision and subtlety.", focus: "features" },
      { text: "Sustains flexible use of these features throughout; effortless for the listener to understand.", focus: "intelligibility" },
    ] },
    { band: 8, items: [
      { text: "Uses a wide range of pronunciation features and sustains them, with only occasional lapses.", focus: "features" },
      { text: "Easy to understand throughout; an L1 accent has minimal effect on intelligibility.", focus: "intelligibility" },
    ] },
    { band: 7, items: [
      { text: "Shows all the positive features of band 6 and some, but not all, of the positive features of band 8.", focus: "features" },
    ] },
    { band: 6, items: [
      { text: "Uses a range of pronunciation features with mixed control.", focus: "features" },
      { text: "Shows some effective use of features, but it is not sustained.", focus: "features" },
      { text: "Can generally be understood throughout, though mispronounced words or sounds reduce clarity at times.", focus: "intelligibility" },
    ] },
    { band: 5, items: [
      { text: "Shows all the positive features of band 4 and some, but not all, of the positive features of band 6.", focus: "features" },
    ] },
    { band: 4, items: [
      { text: "Uses a limited range of pronunciation features; attempts to control them but lapses are frequent.", focus: "features" },
      { text: "Frequent mispronunciation causes the listener some difficulty.", focus: "intelligibility" },
    ] },
    { band: 3, items: [
      { text: "Shows some of the features of band 2 and some, but not all, of the positive features of band 4.", focus: "features" },
    ] },
    { band: 2, items: [
      { text: "Speech is often unintelligible.", focus: "intelligibility" },
    ] },
    { band: 1, items: [
      { text: "No speech that can be assessed.", focus: "intelligibility" },
    ] },
    { band: 0, items: [
      { text: "Does not attend, or produces no assessable language.", focus: "intelligibility" },
    ] },
  ],
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const DIM_ORDER: CriterionKey[] = ["FC", "LR", "GRA", "P"];

/**
 * The complete rubric. IDs are generated from (dimension, band, index) so they
 * never drift, and the array is sorted deterministically (criterion, then band
 * ascending, then id) so snapshots and diffs are stable.
 */
export const BAND_DESCRIPTORS: BandDescriptor[] = (Object.keys(SEEDS) as CriterionKey[])
  .flatMap((dim) =>
    SEEDS[dim].flatMap((seed) =>
      seed.items.map((item, i) => ({
        id: `${dim}-B${seed.band}-${pad2(i + 1)}`,
        dimension: dim,
        band: seed.band,
        text: item.text,
        focus: item.focus,
      })),
    ),
  )
  .sort((a, b) => DIM_ORDER.indexOf(a.dimension) - DIM_ORDER.indexOf(b.dimension) || a.band - b.band || a.id.localeCompare(b.id));

export const DESCRIPTOR_IDS: ReadonlySet<string> = new Set(BAND_DESCRIPTORS.map((d) => d.id));
const BY_ID = new Map(BAND_DESCRIPTORS.map((d) => [d.id, d]));

// ------------------------------------------------------------------ helpers
export function findDescriptor(id: string): BandDescriptor | undefined {
  return BY_ID.get(id);
}

export function isDescriptorId(id: string): boolean {
  return DESCRIPTOR_IDS.has(id);
}

export function descriptorsFor(dimension: CriterionKey, band: number): BandDescriptor[] {
  return BAND_DESCRIPTORS.filter((d) => d.dimension === dimension && d.band === band);
}

export function descriptorBands(dimension: CriterionKey): number[] {
  return [...new Set(BAND_DESCRIPTORS.filter((d) => d.dimension === dimension).map((d) => d.band))].sort((a, b) => a - b);
}

/** The integer bands a half-band score may legitimately cite. */
export function allowedBandsFor(band: number): number[] {
  const lo = Math.floor(band);
  const hi = Math.ceil(band);
  return lo === hi ? [lo] : [lo, hi];
}

/** Official descriptors exist only at integer bands — state the half-band rule explicitly. */
export function halfBandRule(): string {
  return [
    "Band descriptors exist ONLY at integer bands (0–9). There is no official 6.5 wording.",
    "A half band means the performance sits between two adjacent integer bands:",
    "choose the closer integer band as the score, then cite descriptors from the bands it straddles.",
    "Never invent a descriptor id and never present a half band as an official descriptor level.",
  ].join(" ");
}

/** Full rubric for prompt injection, grouped by criterion then band. */
export function descriptorBrief(): string {
  const lines: string[] = [];
  lines.push(`Structured rubric (${DESCRIPTOR_SOURCE.revision}; paraphrase of the public version):`);
  lines.push(halfBandRule());
  for (const c of CRITERIA) {
    lines.push("");
    lines.push(`[${c.key}] ${c.label}`);
    for (const band of BAND_LEVELS) {
      const items = descriptorsFor(c.key, band);
      if (!items.length) continue;
      lines.push(`  B${band}: ${items.map((d) => `${d.id} ${d.text}`).join(" ")}`);
    }
  }
  return lines.join("\n");
}

/** Legacy prompt text (key indicators only). Prefer `descriptorBrief()` for scoring. */
export function criteriaBrief(): string {
  return [
    "IELTS Speaking public band descriptors — key indicators:",
    ...CRITERIA.map((c) => `${c.key} ${c.label}: ${c.indicators.join("; ")}`),
    "Part-specific expectations:",
    ...Object.entries(PART_RULES).map(([p, r]) => `Part ${p}: ${r}`),
    WEIGHT_RULE,
  ].join("\n");
}
