// End-to-end API test against a running server: node tests/integration.mjs [baseUrl]
// Uses synthetic WAV audio + supplied transcripts (simulating the browser ASR path).
// These are TEST INPUTS — they exercise the real pipeline; they are not presented as user results.
import assert from "node:assert/strict";

const BASE = process.argv[2] || "http://localhost:3000";
let cookie = "";
const results = [];
async function req(path, opts = {}) {
  const res = await fetch(BASE + path, { ...opts, headers: { ...(opts.headers || {}), cookie }, redirect: "manual" });
  const sc = res.headers.get("set-cookie");
  if (sc && !cookie) cookie = sc.split(";")[0];
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, body: ct.includes("json") ? await res.json() : await res.arrayBuffer(), headers: res.headers };
}
function wav(seconds, amp = 0.2) {
  const n = 16000 * seconds, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * amp * 32767), 44 + i * 2);
  return b;
}
async function answer(id, step, { text = "", seconds = 8, idem = crypto.randomUUID() } = {}) {
  const fd = new FormData();
  fd.append("examQuestionId", step.id); fd.append("idempotencyKey", idem); fd.append("durationMs", String(seconds * 1000));
  fd.append("wav", new Blob([wav(Math.max(0.2, Math.min(seconds, 3)))], { type: "audio/wav" }), "a.wav");
  if (text) fd.append("browserTranscript", text);
  return req(`/api/speaking/sessions/${id}/answers`, { method: "POST", body: fd });
}
const json = (b) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, e.message]); console.log("FAIL", name, e.message); }
}
const GOOD = [
  "I usually listen to pop music when I'm commuting, because it helps me relax after a long day at work.",
  "My hometown is a medium-sized city in the south. It has changed a lot since I was a child, for example there are many new buildings.",
  "I think reading is important, so I try to read every evening, although sometimes I'm simply too tired to concentrate.",
];
const LONG = "I'd like to talk about learning to swim, which took me a surprisingly long time. When I was about ten my parents enrolled me in lessons at a local pool, but I was terrified of putting my face in the water, so for months I barely made progress. The biggest difficulty was overcoming that fear, and my instructor was incredibly patient. Eventually, after about two years, I could swim confidently, and now I actually find swimming really relaxing, which is ironic considering how much I hated it at first.";

const cfg = (await req("/api/config")).body;
console.log("providers:", JSON.stringify(cfg));
await req("/"); // obtain cookie via proxy
assert.ok(cookie, "cookie issued");

let fullId;
await check("create full mock session", async () => {
  const r = await req("/api/speaking/sessions", json({ mode: "full" }));
  assert.equal(r.status, 201); fullId = r.body.id;
});
await check("reject invalid mode", async () => assert.equal((await req("/api/speaking/sessions", json({ mode: "x" }))).status, 400));

let view = (await req(`/api/speaking/sessions/${fullId}`)).body;
await check("plan has Part 1 → 2 → 3 in order", async () => {
  const parts = view.steps.map((s) => s.part);
  assert.deepEqual([...parts].sort(), parts);
  assert.ok(parts.includes(1) && parts.includes(2) && parts.includes(3));
  assert.equal(view.steps.find((s) => s.part === 2).prepSeconds, 60);
});
await check("out-of-order answer rejected (409)", async () => assert.equal((await answer(fullId, view.steps[2], { text: GOOD[0] })).status, 409));
await check("advance before answering rejected (409)", async () => assert.equal((await req(`/api/speaking/sessions/${fullId}/advance`, json({ fromStep: 0 }))).status, 409));

const idem = crypto.randomUUID();
await check("submit answer + duplicate submission is idempotent", async () => {
  const a = await answer(fullId, view.steps[0], { text: GOOD[0], idem });
  assert.equal(a.status, 201);
  const b = await answer(fullId, view.steps[0], { text: GOOD[0], idem });
  assert.equal(b.status, 200); assert.equal(b.body.duplicate, true); assert.equal(b.body.answerId, a.body.answerId);
});
await check("second answer to same step in mock mode rejected", async () => assert.equal((await answer(fullId, view.steps[0], { text: "again" })).status, 409));
await check("repeat question allowed once then limited", async () => {
  // step 0 already answered but still current → repeat counts allowed by machine
  const r1 = await req(`/api/speaking/sessions/${fullId}/repeat`, json({ examQuestionId: view.steps[0].id }));
  assert.equal(r1.status, 200);
  const r2 = await req(`/api/speaking/sessions/${fullId}/repeat`, json({ examQuestionId: view.steps[0].id }));
  assert.equal(r2.status, 429);
});
await check("advance + duplicate advance is idempotent", async () => {
  const a = await req(`/api/speaking/sessions/${fullId}/advance`, json({ fromStep: 0 }));
  assert.equal(a.body.currentStep, 1);
  const b = await req(`/api/speaking/sessions/${fullId}/advance`, json({ fromStep: 0 }));
  assert.equal(b.body.duplicate, true);
});

let followUps = 0, noResp = false, guard = 0;
await check("complete the rest of the exam (incl. silence, short Part 3 answer → follow-up)", async () => {
  for (;;) {
    if (guard++ > 40) throw new Error("loop");
    view = (await req(`/api/speaking/sessions/${fullId}`)).body;
    const step = view.steps.find((s) => s.stepIndex === view.session.currentStep);
    let r;
    if (step.part === 1 && step.stepIndex === 2 && !noResp) { r = await answer(fullId, step, { seconds: 0.5 }); noResp = true; assert.equal(r.body.status, "no_response"); }
    else if (step.part === 2) r = await answer(fullId, step, { text: LONG, seconds: 95 });
    else if (step.part === 3 && step.kind === "question" && followUps === 0) r = await answer(fullId, step, { text: "Because it is hard.", seconds: 4 });
    else r = await answer(fullId, step, { text: GOOD[step.stepIndex % 3], seconds: 20 });
    assert.ok([200, 201].includes(r.status), `answer status ${r.status}`);
    const adv = await req(`/api/speaking/sessions/${fullId}/advance`, json({ fromStep: step.stepIndex }));
    assert.equal(adv.status, 200, JSON.stringify(adv.body));
    if (adv.body.followUp) followUps++;
    if (adv.body.finished) break;
  }
  assert.ok(followUps >= 1, "a follow-up was inserted");
});
await check("follow-up step is persisted with generator + parent", async () => {
  view = (await req(`/api/speaking/sessions/${fullId}`)).body;
  const f = view.steps.find((s) => s.kind === "follow_up");
  assert.ok(f && ["template", "llm"].includes(f.generator));
  assert.deepEqual(view.steps.map((s) => s.stepIndex), view.steps.map((_, i) => i), "step indexes contiguous after insertion");
});
await check("finish + duplicate finish", async () => {
  const a = await req(`/api/speaking/sessions/${fullId}/finish`, { method: "POST" });
  assert.equal(a.status, 200); assert.equal(a.body.duplicate, false);
  const b = await req(`/api/speaking/sessions/${fullId}/finish`, { method: "POST" });
  assert.equal(b.body.duplicate, true);
});
await check("answers rejected after completion", async () => assert.equal((await answer(fullId, view.steps[0], { text: "late" })).status, 409));

let report;
await check("report generated with four dimensions and honest pronunciation status", async () => {
  for (let i = 0; i < 60; i++) {
    const r = await req(`/api/speaking/sessions/${fullId}/report`);
    if (r.status === 200 && ["completed", "partial", "failed"].includes(r.body.assessment.status)) { report = r.body; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(report, "report ready");
  assert.notEqual(report.assessment.status, "failed", report.assessment.error);
  assert.equal(report.dimensions.length, 4);
  const p = report.dimensions.find((d) => d.dimension === "P");
  if (!cfg.pronunciation) { assert.equal(p.status, "not_assessed"); assert.equal(p.band, null); assert.equal(report.assessment.isComplete, false); }
  assert.ok(report.assessment.promptVersion);
  assert.ok(report.assessment.overallBand >= 1 && report.assessment.overallBand <= 9);
  console.log("   overall", report.assessment.overallBand, report.dimensions.map((d) => `${d.dimension}=${d.band}`).join(" "), "scorer", report.assessment.scorer, "findings", report.findings.length);
});
await check("audio playback with Range (Safari) returns 206", async () => {
  view = (await req(`/api/speaking/sessions/${fullId}`)).body;
  const assetId = view.steps.find((s) => s.answer?.audioAssetId).answer.audioAssetId;
  const r = await req(`/api/audio/${assetId}`, { headers: { range: "bytes=0-99" } });
  assert.equal(r.status, 206); assert.equal(r.body.byteLength, 100);
});
await check("other users cannot access the session", async () => {
  const res = await fetch(`${BASE}/api/speaking/sessions/${fullId}`, { headers: { cookie: "ielts_uid=00000000-0000-4000-8000-000000000000" } });
  assert.equal(res.status, 404);
});
await check("retry scoring creates a new assessment (kept for comparison)", async () => {
  const r = await req(`/api/speaking/sessions/${fullId}/report`, { method: "POST" });
  assert.equal(r.status, 200); assert.ok(r.body.assessmentId);
});

await check("silent exam → scoring fails honestly (no fabricated band)", async () => {
  const id = (await req("/api/speaking/sessions", json({ mode: "part2" }))).body.id;
  const v = (await req(`/api/speaking/sessions/${id}`)).body;
  await answer(id, v.steps[0], { seconds: 0.4 });
  const adv = await req(`/api/speaking/sessions/${id}/advance`, json({ fromStep: 0 }));
  assert.equal(adv.body.finished, true);
  await req(`/api/speaking/sessions/${id}/finish`, { method: "POST" });
  let r;
  for (let i = 0; i < 30; i++) { r = await req(`/api/speaking/sessions/${id}/report`); if (r.status === 200 && r.body.assessment.status !== "pending" && r.body.assessment.status !== "running") break; await new Promise((x) => setTimeout(x, 500)); }
  assert.equal(r.body.assessment.status, "failed"); assert.equal(r.body.assessment.overallBand, null);
});
await check("practice mode allows re-record (attempt 2 becomes current)", async () => {
  const id = (await req("/api/speaking/sessions", json({ mode: "part1" }))).body.id;
  const v = (await req(`/api/speaking/sessions/${id}`)).body;
  await answer(id, v.steps[0], { text: "First try." });
  const second = await answer(id, v.steps[0], { text: "Second, better try with more detail." });
  assert.equal(second.status, 201);
  const v2 = (await req(`/api/speaking/sessions/${id}`)).body;
  assert.equal(v2.steps[0].answer.attempt, 2);
});
await check("abandon (user exits mid-exam) blocks further answers", async () => {
  const id = (await req("/api/speaking/sessions", json({ mode: "part3" }))).body.id;
  const v = (await req(`/api/speaking/sessions/${id}`)).body;
  assert.equal((await req(`/api/speaking/sessions/${id}/abandon`, { method: "POST" })).body.status, "abandoned");
  assert.equal((await answer(id, v.steps[0], { text: "x" })).status, 409);
});
await check("refresh/resume: session state is server-side", async () => {
  const id = (await req("/api/speaking/sessions", json({ mode: "part1" }))).body.id;
  const v = (await req(`/api/speaking/sessions/${id}`)).body;
  await answer(id, v.steps[0], { text: GOOD[0] });
  await req(`/api/speaking/sessions/${id}/advance`, json({ fromStep: 0 }));
  const again = (await req(`/api/speaking/sessions/${id}`)).body; // simulates reload
  assert.equal(again.session.currentStep, 1); assert.equal(again.steps[0].status, "answered");
});
await check("non-audio upload rejected (415)", async () => {
  const id = (await req("/api/speaking/sessions", json({ mode: "part1" }))).body.id;
  const v = (await req(`/api/speaking/sessions/${id}`)).body;
  const fd = new FormData();
  fd.append("examQuestionId", v.steps[0].id); fd.append("idempotencyKey", crypto.randomUUID()); fd.append("durationMs", "5000");
  fd.append("audio", new Blob(["hello"], { type: "text/plain" }), "x.txt");
  assert.equal((await req(`/api/speaking/sessions/${id}/answers`, { method: "POST", body: fd })).status, 415);
});

// ------------------------------------------------------------------ examiner TTS
if (cfg.tts && cfg.tts.location === "server") {
  const line = "Thank you. That is the end of the speaking test.";
  const url = `/api/tts?text=${encodeURIComponent(line)}&voice=auto`;
  await check("TTS: progressive GET returns audio", async () => {
    const r = await req(url);
    assert.equal(r.status, 200);
    assert.ok((r.headers.get("content-type") || "").startsWith("audio/"), "audio content type");
    assert.ok(r.body.byteLength > 1000, "non-empty clip");
  });
  await check("TTS: repeated line is served from the server cache", async () => {
    const r = await req(url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-tts-cache"), "hit");
    assert.ok(r.body.byteLength > 1000);
  });
  await check("TTS: POST compatibility path still returns audio", async () => {
    const r = await req("/api/tts", json({ text: "Thank you.", voice: "auto" }));
    assert.equal(r.status, 200);
    assert.ok(r.body.byteLength > 1000);
  });
} else {
  console.log("SKIP TTS checks (browser TTS active)");
}

const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} integration checks passed`);
process.exit(failed.length ? 1 : 0);
