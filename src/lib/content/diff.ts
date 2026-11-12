/**
 * Word-level comparison between a model answer and an ASR transcript.
 *
 * HONESTY CONSTRAINTS (product-level, not just wording):
 *   - ASR output is evidence of what the engine *heard*, not of what the learner
 *     said. A "missing" word may be a perfect pronunciation that the recogniser
 *     dropped, so every difference here is labelled 参考 (reference only).
 *   - Nothing in this module produces a pronunciation score, a phoneme verdict
 *     or a band. The only numeric outputs are word counts and speaking rate,
 *     both of which are measurements of the recording, not judgements.
 */
export interface DiffToken {
  kind: "match" | "missing" | "extra" | "changed";
  /** Token from the reference (model answer). */
  ref?: string;
  /** Token from the transcript. */
  got?: string;
}

export interface WordDiff {
  tokens: DiffToken[];
  missing: string[];
  extra: string[];
  changed: { ref: string; got: string }[];
  matched: number;
  refWords: number;
  /** 0–1, matched / reference words. Descriptive only. */
  matchRate: number;
}

/** Normalise a token for comparison: lowercase, strip surrounding punctuation. */
export function normalizeToken(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^a-z0-9']+/, "")
    .replace(/[^a-z0-9']+$/, "")
    .replace(/'(?=\s|$)/g, "");
}

export function tokenize(text: string): string[] {
  return text.split(/\s+/).map((w) => w.trim()).filter(Boolean);
}

/**
 * Classic LCS alignment. Answers are short (≤ 250 words), so an O(n·m) table is
 * cheaper than the ceremony of a fancier algorithm.
 */
export function diffWords(reference: string, transcript: string): WordDiff {
  const ref = tokenize(reference);
  const got = tokenize(transcript);
  const a = ref.map(normalizeToken);
  const b = got.map(normalizeToken);

  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  let matched = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      tokens.push({ kind: "match", ref: ref[i], got: got[j] });
      matched += 1;
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      tokens.push({ kind: "missing", ref: ref[i] });
      i += 1;
    } else {
      tokens.push({ kind: "extra", got: got[j] });
      j += 1;
    }
  }
  while (i < n) {
    tokens.push({ kind: "missing", ref: ref[i] });
    i += 1;
  }
  while (j < m) {
    tokens.push({ kind: "extra", got: got[j] });
    j += 1;
  }

  // A missing word immediately followed by an extra word is usually the same
  // slot said differently → report it as a substitution, which reads better
  // than two separate errors.
  const merged: DiffToken[] = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const cur = tokens[k];
    const next = tokens[k + 1];
    if (cur.kind === "missing" && next?.kind === "extra") {
      merged.push({ kind: "changed", ref: cur.ref, got: next.got });
      k += 1;
    } else {
      merged.push(cur);
    }
  }

  return {
    tokens: merged,
    missing: merged.filter((t) => t.kind === "missing").map((t) => t.ref!),
    extra: merged.filter((t) => t.kind === "extra").map((t) => t.got!),
    changed: merged.filter((t) => t.kind === "changed").map((t) => ({ ref: t.ref!, got: t.got! })),
    matched,
    refWords: n,
    matchRate: n ? Math.round((matched / n) * 1000) / 1000 : 0,
  };
}

export interface SpeechStats {
  words: number;
  durationMs: number;
  /** Words per minute, rounded. 0 when the duration is unknown. */
  wpm: number;
}

/** Measurements of the learner's own recording — not a fluency score. */
export function speechStats(text: string, durationMs: number): SpeechStats {
  const words = tokenize(text).length;
  const minutes = durationMs > 0 ? durationMs / 60000 : 0;
  return { words, durationMs: Math.max(0, Math.round(durationMs)), wpm: minutes ? Math.round(words / minutes) : 0 };
}

/** Very short, non-judgemental practice hints derived only from the diff. */
export function practiceHints(diff: WordDiff, stats: SpeechStats): string[] {
  const hints: string[] = [];
  if (diff.refWords === 0) return hints;
  if (diff.missing.length >= Math.max(2, Math.round(diff.refWords * 0.15))) {
    hints.push(`有 ${diff.missing.length} 处参考词未出现在转写中，先放慢语速逐句跟读，再整段连读。`);
  }
  if (diff.changed.length) {
    hints.push(`有 ${diff.changed.length} 处表达与示范不同（不一定是错误），可对比两种说法。`);
  }
  if (stats.wpm && stats.wpm > 190) hints.push(`语速约 ${stats.wpm} wpm，偏快；示范答案按 130–160 wpm 更易听清。`);
  if (stats.wpm && stats.wpm < 90 && diff.refWords > 20) hints.push(`语速约 ${stats.wpm} wpm，偏慢；先练熟句子再提速。`);
  if (!diff.missing.length && !diff.changed.length) hints.push("转写与示范几乎一致，可以尝试脱稿复述。");
  return hints;
}
