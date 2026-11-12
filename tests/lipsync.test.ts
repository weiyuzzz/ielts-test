/**
 * Lip-sync core: viseme mapping, timeline build/warp/sample. Pure functions.
 * Run with: npx tsx --test tests/lipsync.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRelativeTrack, warpToRealTime, sampleTrack, jawFromChannels, type PhonemeWord } from "../src/lib/lipsync/timeline";
import { tokenizeMisaki } from "../src/lib/lipsync/viseme-map";
import { tokenizeFromLetters } from "../src/lib/lipsync/letter-g2p";
import { VISEME_CHANNELS, visemeIndex, type Viseme } from "../src/lib/lipsync/types";

const w = (word: string, phonemes: string): PhonemeWord => ({ word, phonemes });
const out = new Float32Array(VISEME_CHANNELS.length);

test("tokenizeMisaki longest-first, skips stress marks", () => {
  assert.deepEqual(tokenizeMisaki("həlˈQ"), ["h", "ə", "l", "Q"]);
  assert.deepEqual(tokenizeMisaki("iː"), ["iː"]);
  assert.deepEqual(tokenizeMisaki("sˈɛːɹə"), ["s", "ɛː", "ɹ", "ə"]);
  assert.deepEqual(tokenizeMisaki("ʤˈʌmp"), ["ʤ", "ʌ", "m", "p"]);
});

test("letter fallback produces only known visemes", () => {
  for (const word of ["Hello", "identification", "xyzzy", "examiner"]) {
    const syms = tokenizeFromLetters(word);
    assert.ok(syms.length > 0, word);
    for (const s of syms) {
      assert.ok(VISEME_CHANNELS.includes(s.slice(1) as Viseme), s);
    }
  }
});

test("buildRelativeTrack: sorted contiguous frames + word spans", () => {
  const track = buildRelativeTrack([w("Hello", "həlˈQ."), w("My", "mˌI")]);
  assert.ok(track.frames.length > 4);
  assert.equal(track.words.length, 2);
  let t = 0;
  for (const f of track.frames) {
    assert.ok(f.t >= t - 1e-9);
    t = f.t + f.d;
  }
  assert.ok(Math.abs(track.duration - t) < 1e-9);
  assert.ok(track.words[0].start < track.words[0].end);
  assert.ok(track.words[1].start >= track.words[0].end - 1e-9);
});

test("buildRelativeTrack: silence pause after sentence punctuation", () => {
  const track = buildRelativeTrack([w("Stop.", "stˈɒp."), w("Go", "ɡˈQ")]);
  const sil = track.frames.find((f) => f.viseme === "sil");
  assert.ok(sil);
  assert.ok(sil.d >= 0.25);
});

test("warpToRealTime: global scale without anchors", () => {
  const track = buildRelativeTrack([w("One", "wˈʌn"), w("Two", "tˈuː"), w("Three", "θɹˈiː")]);
  const warped = warpToRealTime(track, { realDuration: 6 });
  assert.equal(warped.realDuration, 6);
  const last = warped.frames[warped.frames.length - 1];
  assert.ok(last.t + last.d <= 6.02);
  assert.equal(warped.realWords, null);
});

test("warpToRealTime: word anchors place frames inside measured windows", () => {
  const track = buildRelativeTrack([w("One", "wˈʌn"), w("Two", "tˈuː"), w("Three", "θɹˈiː")]);
  const anchors = [
    { word: "One", start: 0.2, end: 0.9, index: 0 },
    { word: "Two", start: 1.4, end: 2.1, index: 1 },
    { word: "Three", start: 2.8, end: 3.9, index: 2 },
  ];
  const warped = warpToRealTime(track, { realDuration: 4.2, wordAnchors: anchors });
  assert.ok(warped.realWords);
  for (let i = 0; i < 3; i++) {
    const frames = warped.frames.filter((f) => f.wordIndex === i);
    assert.ok(frames.length > 0, `word ${i}`);
    for (const f of frames) {
      assert.ok(f.t >= anchors[i].start - 0.05, `word ${i} start ${f.t}`);
      assert.ok(f.t + f.d <= anchors[i].end + 0.05, `word ${i} end ${f.t + f.d}`);
    }
  }
});

test("warpToRealTime: ignores anchors with mismatched count", () => {
  const track = buildRelativeTrack([w("One", "wˈʌn"), w("Two", "tˈuː")]);
  const warped = warpToRealTime(track, { realDuration: 3, wordAnchors: [{ word: "One", start: 0, end: 1, index: 0 }] });
  assert.equal(warped.realWords, null);
});

test("warpToRealTime: degenerate duration stays finite", () => {
  const track = buildRelativeTrack([w("One", "wˈʌn")]);
  const warped = warpToRealTime(track, { realDuration: 0 });
  assert.ok(Number.isFinite(warped.frames[0].t));
});

test("sampleTrack: silent outside the track", () => {
  const warped = warpToRealTime(buildRelativeTrack([w("Hello", "həlˈQ")]), { realDuration: 1 });
  sampleTrack(warped, -0.5, out);
  assert.ok(out.every((v) => v === 0));
  sampleTrack(warped, warped.realDuration + 0.2, out);
  assert.ok(out.reduce((a, b) => a + b, 0) < 0.35);
});

test("sampleTrack: strongest channel matches the frame's viseme", () => {
  const warped = warpToRealTime(buildRelativeTrack([w("Hello", "həlˈQ")]), { realDuration: 1 });
  const mid = warped.frames.find((f) => f.viseme !== "sil")!;
  sampleTrack(warped, mid.t + mid.d / 2, out);
  const maxIdx = out.indexOf(Math.max(...out));
  assert.equal(VISEME_CHANNELS[maxIdx], mid.viseme);
  assert.ok(out[maxIdx] > 0.4);
});

test("sampleTrack: sil frames close the mouth between words", () => {
  const warped = warpToRealTime(buildRelativeTrack([w("One", "wˈʌn."), w("Two", "tˈuː")]), { realDuration: 2 });
  const sil = warped.frames.find((f) => f.viseme === "sil");
  assert.ok(sil, "warped track keeps the sil frame");
  sampleTrack(warped, sil.t + sil.d / 2, out);
  assert.ok(out.reduce((a, b) => a + b, 0) < 0.4);
});

test("jawFromChannels: vowels open more than consonants", () => {
  const vowel = new Float32Array(VISEME_CHANNELS.length);
  vowel[visemeIndex("aa")] = 0.8;
  const cons = new Float32Array(VISEME_CHANNELS.length);
  cons[visemeIndex("SS")] = 0.8;
  assert.ok(jawFromChannels(vowel) > jawFromChannels(cons) * 2);
});

test("visemeIndex maps channels consistently", () => {
  assert.equal(visemeIndex("sil"), 0);
  assert.equal(visemeIndex("aa"), VISEME_CHANNELS.indexOf("aa"));
});
