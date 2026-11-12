// End-to-end API test against a running server: node tests/integration.mjs [baseUrl]
// Uses synthetic WAV audio + supplied transcripts (simulating the browser ASR path).
// These are TEST INPUTS — they exercise the real pipeline; they are not presented as user results.
import assert from "node:assert/strict";
import pg from "pg";

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
await check("admin: a mainland seasonal bank is imported and active", async () => {
  const r = await req("/api/admin/banks");
  assert.equal(r.status, 200);
  const active = r.body.banks.find((b) => b.isActive);
  assert.ok(active, "one active bank");
  assert.equal(active.region, "大陆地区");
  assert.ok(active.counts.part1 >= 100 && active.counts.part2 >= 40 && active.counts.part3 >= 40, JSON.stringify(active.counts));
  const d = await req(`/api/admin/banks?id=${active.id}`);
  assert.equal(d.status, 200);
  assert.ok(d.body.topics.length >= 50, "bank content is browsable");
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
  assert.equal(followUps, 0, "a full mock follows the fixed bank script and invents no follow-ups");
});
await check("full mock: 3 Part 1 topics / 11 questions, one cue card, bank questions only", async () => {
  view = (await req(`/api/speaking/sessions/${fullId}`)).body;
  const p1 = view.steps.filter((s) => s.part === 1);
  assert.equal(p1.length, 11);
  assert.equal(new Set(p1.map((s) => s.topic)).size, 3);
  assert.equal(view.steps.filter((s) => s.part === 2).length, 1);
  assert.equal(view.steps.filter((s) => s.part === 3).length, 4);
  assert.ok(view.steps.every((s) => s.generator === "bank"), "every question comes from the active bank");
  assert.deepEqual(view.steps.map((s) => s.stepIndex), view.steps.map((_, i) => i));
});
await check("practice mode may still generate a follow-up", async () => {
  const id = (await req("/api/speaking/sessions", json({ mode: "part3" }))).body.id;
  const v = (await req(`/api/speaking/sessions/${id}`)).body;
  await answer(id, v.steps[0], { text: "Because it is hard.", seconds: 4 });
  const adv = await req(`/api/speaking/sessions/${id}/advance`, json({ fromStep: 0 }));
  assert.ok(adv.body.followUp || adv.body.finished, "practice either probes or finishes");
});
await check("finish + duplicate finish", async () => {
  const a = await req(`/api/speaking/sessions/${fullId}/finish`, { method: "POST" });
  assert.equal(a.status, 200); assert.equal(a.body.duplicate, false);
  const b = await req(`/api/speaking/sessions/${fullId}/finish`, { method: "POST" });
  assert.equal(b.body.duplicate, true);
});
await check("answers rejected after completion", async () => assert.equal((await answer(fullId, view.steps[0], { text: "late" })).status, 409));

let report;
await check("scoring: no AI provider → exam completes unscored, never fabricates a band", async () => {
  for (let i = 0; i < 60; i++) {
    const r = await req(`/api/speaking/sessions/${fullId}/report`);
    if (r.status === 200 && ["unscored", "completed", "partial", "failed"].includes(r.body.assessment.status)) { report = r.body; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(report, "report ready");
  if (!cfg.llm) {
    assert.equal(report.assessment.status, "unscored");
    assert.equal(report.assessment.overallBand, null);
    assert.equal(report.assessment.scorer, null);
    assert.equal(report.dimensions.length, 0, "no bands without AI scoring");
    assert.ok((report.assessment.notes || []).some((n) => /AI|未接入/.test(n)));
  } else {
    assert.notEqual(report.assessment.status, "failed", report.assessment.error);
    assert.equal(report.dimensions.length, 4);
    assert.ok(report.assessment.promptVersion);
    if (!cfg.pronunciation) {
      const p = report.dimensions.find((d) => d.dimension === "P");
      assert.equal(p.status, "not_assessed");
      assert.equal(report.assessment.isComplete, false);
      assert.equal(report.assessment.overallBand, null, "four criteria each 25%: no overall band when P is missing");
    }
  }
  console.log("   scorer", report.assessment.scorer, "status", report.assessment.status, "overall", report.assessment.overallBand);
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
  assert.equal(r.body.assessment.status, cfg.llm ? "failed" : "unscored");
  assert.equal(r.body.assessment.overallBand, null);
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

// ------------------------------------------------------------------ phase-1: unified complete-answer
function completeForm(step, fromStep, idem, text = GOOD[0]) {
  const fd = new FormData();
  fd.append("examQuestionId", step.id);
  fd.append("idempotencyKey", idem);
  fd.append("durationMs", "5000");
  fd.append("fromStep", String(fromStep));
  fd.append("wav", new Blob([wav(1)], { type: "audio/wav" }), "a.wav");
  if (text) fd.append("browserTranscript", text);
  return fd;
}

await check("complete-answer: ONE request submits, advances and returns the full next-step view", async () => {
  const id = (await req("/api/speaking/sessions", json({ mode: "part1" }))).body.id;
  const v0 = (await req(`/api/speaking/sessions/${id}`)).body;
  const idem = crypto.randomUUID();
  const t0 = Date.now();
  const r = await req(`/api/speaking/sessions/${id}/complete-answer`, { method: "POST", body: completeForm(v0.steps[0], 0, idem) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.answer.answerId);
  assert.equal(r.body.answer.status, "answered");
  assert.equal(r.body.advance.currentStep, 1, "state machine advanced");
  assert.equal(r.body.view.session.currentStep, 1, "view is authoritative, no extra GET needed");
  assert.equal(r.body.view.steps[0].status, "answered");
  assert.ok(r.body.view.steps.length > 1, "next question's full info is present");
  assert.equal(typeof r.body.timings.advanceMs, "number");
  assert.equal(r.body.answer.asrDurationMs, 0, "no synchronous ASR wait for this step");
  console.log("   complete-answer round trip", Date.now() - t0, "ms");

  const again = await req(`/api/speaking/sessions/${id}/complete-answer`, { method: "POST", body: completeForm(v0.steps[0], 0, idem) });
  assert.equal(again.status, 200);
  assert.equal(again.body.answer.duplicate, true, "idempotency key is honoured");
  assert.equal(again.body.answer.answerId, r.body.answer.answerId);
  assert.equal(again.body.view.session.currentStep, 1, "retry never double-advances");

  const bad = await req(`/api/speaking/sessions/${id}/complete-answer`, { method: "POST", body: completeForm(v0.steps[2], 1, crypto.randomUUID()) });
  assert.equal(bad.status, 409, "out-of-order step is rejected by the state machine");
});

await check("complete-answer: full mock never waits on synchronous Part 3 ASR", async () => {
  const id = (await req("/api/speaking/sessions", json({ mode: "full" }))).body.id;
  const v = (await req(`/api/speaking/sessions/${id}`)).body;
  const r = await req(`/api/speaking/sessions/${id}/complete-answer`, { method: "POST", body: completeForm(v.steps[0], 0, crypto.randomUUID()) });
  assert.equal(r.status, 201);
  assert.equal(r.body.answer.asrDurationMs, 0, "full mock defers transcription to scoring");
  assert.equal(r.body.advance.followUp, undefined, "no invented follow-up in a full mock");
});

await check("complete-answer: legacy /answers and /advance endpoints still work", async () => {
  const id = (await req("/api/speaking/sessions", json({ mode: "part1" }))).body.id;
  const v = (await req(`/api/speaking/sessions/${id}`)).body;
  const a = await answer(id, v.steps[0], { text: GOOD[0] });
  assert.equal(a.status, 201);
  const adv = await req(`/api/speaking/sessions/${id}/advance`, json({ fromStep: 0 }));
  assert.equal(adv.body.currentStep, 1);
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
    assert.ok(["hit", "miss", "miss-stream"].includes(r.headers.get("x-tts-cache")), "cache classification header");
    assert.ok(r.headers.get("x-tts-synthesis-ms") !== null, "synthesis timing header feeds the dev trace");
    assert.ok(r.headers.get("server-timing") !== null, "Server-Timing header present");
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
    assert.ok(r.headers.get("x-tts-synthesis-ms") !== null);
  });
} else {
  console.log("SKIP TTS checks (browser TTS active)");
}

// ------------------------------------------------- descriptorRefs persistence
// Real PostgreSQL round trip (no mocks): write rubric ids, read them back with
// SQL, then read them back again through the report API the UI consumes.
if (process.env.DATABASE_URL) {
  await check("descriptorRefs: rubric ids persist to PostgreSQL and are returned by the report API", async () => {
    const id = (await req("/api/speaking/sessions", json({ mode: "part1" }))).body.id;
    assert.ok(id, "session created");
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const { rows: aRows } = await db.query(
        `insert into assessments (session_id, status, stage, scorer, is_complete, prompt_version, completed_at)
         values ($1,'completed','done','llm',true,'speaking-language-v3.0-rubric', now()) returning id`,
        [id],
      );
      const assessmentId = aRows[0].id;
      const refs = ["GRA-B6-02", "LR-B7-01"];
      await db.query(
        `insert into assessment_findings (assessment_id, dimension, kind, category, original_text, explanation, descriptor_refs)
         values ($1,'GRA','error','conditionals',$2,$3,$4::jsonb)`,
        [assessmentId, "if you can use a computer well you can find a better job", "Complex conditional used with an inconsistent tense sequence.", JSON.stringify(refs)],
      );
      // Legacy-style insert that omits the column entirely → must default to [].
      await db.query(
        `insert into assessment_findings (assessment_id, dimension, kind, category, original_text, explanation)
         values ($1,'LR','strength','collocation',$2,$3)`,
        [assessmentId, "frightened of the water", "Natural collocation."],
      );

      const { rows } = await db.query(`select descriptor_refs from assessment_findings where assessment_id=$1`, [assessmentId]);
      assert.equal(rows.length, 2);
      const stored = rows.find((r) => Array.isArray(r.descriptor_refs) && r.descriptor_refs.length);
      assert.ok(stored, "descriptor_refs is a JSONB array, not a string");
      assert.deepEqual(stored.descriptor_refs, refs, "array content survives the round trip");
      const legacy = rows.find((r) => Array.isArray(r.descriptor_refs) && r.descriptor_refs.length === 0);
      assert.ok(legacy, "a row written without descriptor_refs defaults to []");

      const r = await req(`/api/speaking/sessions/${id}/report`);
      assert.equal(r.status, 200);
      assert.equal(r.body.findings.length, 2);
      assert.ok(r.body.findings.every((f) => Array.isArray(f.descriptorRefs)), "report never returns undefined descriptorRefs");
      const viaApi = r.body.findings.find((f) => f.descriptorRefs.length);
      assert.deepEqual(viaApi.descriptorRefs, refs, "report API exposes the persisted ids");
    } finally {
      await db.query(`delete from exam_sessions where id=$1`, [id]).catch(() => {});
      await db.end().catch(() => {});
    }
  });
} else {
  console.log("SKIP descriptorRefs persistence check (no DATABASE_URL)");
}

const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} integration checks passed`);
process.exit(failed.length ? 1 : 0);
