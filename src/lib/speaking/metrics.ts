/**
 * Deterministic, explainable speech metrics computed from transcripts (+ word timings
 * when the ASR provides them). Always available, independent of any LLM.
 */
import type { WordTiming } from "@/db/schema";

export interface AnswerInput {
  answerId: string;
  part: number;
  prompt: string;
  text: string;
  durationMs: number;
  words?: WordTiming[] | null;
  noResponse?: boolean;
}

export interface AnswerMetrics {
  answerId: string;
  wordCount: number;
  wpm: number | null;
  fillerCount: number;
  fillers: string[];
  repetitionCount: number;
  repeatedPhrases: string[];
  longPauses: number | null;
  connectives: string[];
  complexMarkers: number;
  sentenceCount: number;
  avgSentenceLength: number;
  uniqueRatio: number;
  advancedWordRatio: number;
  topWords: { word: string; count: number }[];
}

export interface AggregateMetrics {
  totalWords: number;
  speakingSeconds: number;
  wpm: number | null;
  fillerRate: number;
  repetitionRate: number;
  connectiveVariety: number;
  complexPer100: number;
  mattr: number;
  advancedWordRatio: number;
  avgSentenceLength: number;
  longPausesPerMin: number | null;
  noResponseCount: number;
  answers: AnswerMetrics[];
}

const FILLERS = ["um", "uh", "er", "erm", "ah", "hmm", "you know", "i mean", "like", "kind of", "sort of"];
const CONNECTIVES = [
  "because", "so", "however", "although", "though", "but", "and then", "for example", "for instance", "such as",
  "on the other hand", "whereas", "while", "therefore", "as a result", "in addition", "moreover", "besides",
  "firstly", "secondly", "finally", "actually", "in fact", "overall", "to be honest", "personally", "apart from",
  "that's why", "which means", "even though", "unless", "otherwise", "instead",
];
const COMPLEX = [
  "which", "who", "whom", "whose", "where", "when i", "if", "unless", "although", "even though", "because",
  "since", "would have", "could have", "should have", "had been", "have been", "has been", "was being",
  "not only", "the more", "what i", "whether", "so that", "in order to",
];
// Small list of very common English words; words outside it and ≥ 7 letters count as "less common".
const COMMON = new Set(
  ("the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were been has had did does very really thing things lot much more many something everything nothing quite pretty always often usually sometimes never maybe yes yeah okay ok because family friends home school study job city place live house food weather music like love enjoy nice great big small little old young happy busy interesting important different same around another every each ever still again here where why life world today week weekend month morning night watch read play went go going got getting made doing said told feel felt think thought")
    .split(/\s+/),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z']+/g) ?? []).filter(Boolean);
}

function countPhrase(tokens: string[], phrase: string): number {
  const p = phrase.split(" ");
  let c = 0;
  for (let i = 0; i + p.length <= tokens.length; i++) {
    if (p.every((w, j) => tokens[i + j] === w)) c++;
  }
  return c;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Moving-average type-token ratio, robust to answer length. */
export function mattr(tokens: string[], window = 40): number {
  if (tokens.length === 0) return 0;
  if (tokens.length <= window) return new Set(tokens).size / tokens.length;
  let sum = 0;
  let n = 0;
  for (let i = 0; i + window <= tokens.length; i++) {
    sum += new Set(tokens.slice(i, i + window)).size / window;
    n++;
  }
  return sum / n;
}

export function analyzeAnswer(a: AnswerInput): AnswerMetrics {
  const tokens = tokenize(a.text);
  const fillers: string[] = [];
  let fillerCount = 0;
  for (const f of FILLERS) {
    // "like" is only a filler when surrounded by commas or doubled; count conservatively
    const c = f === "like" ? (a.text.toLowerCase().match(/,\s*like\s*,/g) ?? []).length : countPhrase(tokens, f);
    if (c) {
      fillerCount += c;
      fillers.push(`${f}×${c}`);
    }
  }
  // immediate repetitions ("I I", "the the", "I think I think")
  const repeatedPhrases: string[] = [];
  let repetitionCount = 0;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === tokens[i - 1] && !["very", "really", "so", "no", "bye"].includes(tokens[i])) {
      repetitionCount++;
      repeatedPhrases.push(`${tokens[i]} ${tokens[i]}`);
    }
    if (i >= 3 && tokens[i] === tokens[i - 2] && tokens[i - 1] === tokens[i - 3] && tokens[i] !== tokens[i - 1]) {
      repetitionCount++;
      repeatedPhrases.push(`${tokens[i - 1]} ${tokens[i]} ${tokens[i - 1]} ${tokens[i]}`);
    }
  }
  const connectives = CONNECTIVES.filter((c) => countPhrase(tokens, c.replace(/'/g, "'")) > 0);
  const complexMarkers = COMPLEX.reduce((n, c) => n + countPhrase(tokens, c), 0);
  const sentences = splitSentences(a.text);
  const sentenceCount = Math.max(1, sentences.length);
  const content = tokens.filter((t) => t.length > 3 && !COMMON.has(t));
  const freq = new Map<string, number>();
  for (const t of content) freq.set(t, (freq.get(t) ?? 0) + 1);
  const topWords = [...freq.entries()]
    .filter(([, c]) => c >= 3)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5)
    .map(([word, count]) => ({ word, count }));

  let longPauses: number | null = null;
  let speakingMs = a.durationMs;
  if (a.words && a.words.length > 1) {
    longPauses = 0;
    for (let i = 1; i < a.words.length; i++) if (a.words[i].start - a.words[i - 1].end > 1.2) longPauses++;
    speakingMs = Math.max(1, (a.words[a.words.length - 1].end - a.words[0].start) * 1000);
  }
  const wpm = tokens.length >= 5 && speakingMs > 3000 ? Math.round((tokens.length / speakingMs) * 60000) : null;

  return {
    answerId: a.answerId,
    wordCount: tokens.length,
    wpm,
    fillerCount,
    fillers,
    repetitionCount,
    repeatedPhrases: [...new Set(repeatedPhrases)].slice(0, 6),
    longPauses,
    connectives,
    complexMarkers,
    sentenceCount,
    avgSentenceLength: tokens.length / sentenceCount,
    uniqueRatio: tokens.length ? new Set(tokens).size / tokens.length : 0,
    advancedWordRatio: tokens.length ? tokens.filter((t) => t.length >= 7 && !COMMON.has(t)).length / tokens.length : 0,
    topWords,
  };
}

export function aggregate(answers: AnswerInput[]): AggregateMetrics {
  const per = answers.map(analyzeAnswer);
  const allTokens = answers.flatMap((a) => tokenize(a.text));
  const totalWords = allTokens.length;
  const speakingSeconds = answers.reduce((s, a) => s + a.durationMs, 0) / 1000;
  const withWpm = per.filter((p) => p.wpm !== null);
  const wpm = withWpm.length
    ? Math.round(withWpm.reduce((s, p) => s + (p.wpm as number) * p.wordCount, 0) / withWpm.reduce((s, p) => s + p.wordCount, 0))
    : null;
  const pauses = per.filter((p) => p.longPauses !== null);
  const sentences = per.reduce((s, p) => s + p.sentenceCount, 0);
  return {
    totalWords,
    speakingSeconds,
    wpm,
    fillerRate: totalWords ? (per.reduce((s, p) => s + p.fillerCount, 0) / totalWords) * 100 : 0,
    repetitionRate: totalWords ? (per.reduce((s, p) => s + p.repetitionCount, 0) / totalWords) * 100 : 0,
    connectiveVariety: new Set(per.flatMap((p) => p.connectives)).size,
    complexPer100: totalWords ? (per.reduce((s, p) => s + p.complexMarkers, 0) / totalWords) * 100 : 0,
    mattr: mattr(allTokens),
    advancedWordRatio: totalWords ? allTokens.filter((t) => t.length >= 7 && !COMMON.has(t)).length / totalWords : 0,
    avgSentenceLength: sentences ? totalWords / sentences : 0,
    longPausesPerMin: pauses.length && speakingSeconds > 0 ? (pauses.reduce((s, p) => s + (p.longPauses as number), 0) / speakingSeconds) * 60 : null,
    noResponseCount: answers.filter((a) => a.noResponse || tokenize(a.text).length === 0).length,
    answers: per,
  };
}
