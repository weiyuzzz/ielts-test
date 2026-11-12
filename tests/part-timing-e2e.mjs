// Part-time-limit contract against a running server: node tests/part-timing-e2e.mjs [baseUrl]
//
// Covers the "time is up for this part" path: a part must close without losing a
// recorded answer, jump to the FIRST question of the next part (not the next
// question of the same part), be idempotent, and still allow the exam to finish.
let BASE = process.argv[2] || "http://localhost:3000";
BASE = BASE.replace(/\/$/, "");
let cookie = "";

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  const sc = res.headers.get("set-cookie");
  if (sc && !cookie) cookie = sc.split(";")[0];
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, body: ct.includes("json") ? await res.json() : null };
}
const post = (p, b) => req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

const checks = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { checks.push(["PASS", name]); console.log("PASS", name); })
    .catch((e) => { checks.push(["FAIL", name, e.message]); console.log("FAIL", name, e.message); });
}

await req("/");
if (!cookie) {
  console.error("no session cookie — is the server running at " + BASE + "?");
  process.exit(1);
}

const created = await req("/api/speaking/sessions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ mode: "full" }),
});
const id = created.body?.id;
const view = (await req(`/api/speaking/sessions/${id}`)).body;
const steps = view.steps;
const firstP2 = steps.find((s) => s.part === 2);
const firstP3 = steps.find((s) => s.part === 3);
const lastIndex = Math.max(...steps.map((s) => s.stepIndex));
const p1Count = steps.filter((s) => s.part === 1).length;

await check("Part 1 answers are capped at 30 seconds", () => {
  const p1 = steps.filter((s) => s.part === 1);
  if (!p1.length) throw new Error("no Part 1 steps");
  for (const s of p1) if (s.answerSeconds !== 30) throw new Error(`step ${s.stepIndex} has ${s.answerSeconds}s`);
});

await check("skip-part closes Part 1 and lands on the Part 2 cue card", async () => {
  const r = await post(`/api/speaking/sessions/${id}/skip-part`, { fromStep: 0 });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (r.body.currentStep !== firstP2.stepIndex) throw new Error(`landed on ${r.body.currentStep}, expected ${firstP2.stepIndex}`);
  if (r.body.partChanged !== true) throw new Error("partChanged not reported");
  const skipped = r.body.view.steps.filter((s) => s.status === "skipped").length;
  if (skipped !== p1Count) throw new Error(`skipped ${skipped}, expected all ${p1Count} Part 1 steps`);
  const cur = r.body.view.steps.find((s) => s.stepIndex === r.body.currentStep);
  if (cur.part !== 2 || cur.kind !== "cue_card") throw new Error("next step is not the cue card");
});

await check("a stale fromStep cannot skip a second part", async () => {
  const r = await post(`/api/speaking/sessions/${id}/skip-part`, { fromStep: 0 });
  if (r.body.currentStep !== firstP2.stepIndex) throw new Error("cursor moved again");
  if (r.body.duplicate !== true) throw new Error("not flagged duplicate");
});

await check("skipping Part 2 lands on the first Part 3 question", async () => {
  const r = await post(`/api/speaking/sessions/${id}/skip-part`, { fromStep: firstP2.stepIndex });
  if (r.body.currentStep !== firstP3.stepIndex) throw new Error(`landed on ${r.body.currentStep}, expected ${firstP3.stepIndex}`);
  const cur = r.body.view.steps.find((s) => s.stepIndex === r.body.currentStep);
  if (cur.part !== 3) throw new Error("not in Part 3");
});

await check("skipping the last part reports finished and parks on the last step", async () => {
  const r = await post(`/api/speaking/sessions/${id}/skip-part`, { fromStep: firstP3.stepIndex });
  if (r.body.finished !== true) throw new Error("finished not reported");
  if (r.body.currentStep !== lastIndex) throw new Error(`currentStep ${r.body.currentStep}, expected last ${lastIndex}`);
});

await check("the exam can still be finished after every part timed out", async () => {
  const r = await req(`/api/speaking/sessions/${id}/finish`, { method: "POST" });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (r.body.status !== "completed") throw new Error(`status ${r.body.status}`);
});

await check("an answer recorded while the clock expires is kept, not lost", async () => {
  const s2 = (await req("/api/speaking/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "part1" }),
  })).body;
  const v = (await req(`/api/speaking/sessions/${s2.id}`)).body;
  const step = v.steps[0];
  const wav = Buffer.alloc(44 + 16000 * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + 16000 * 2, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(16000 * 2, 40);
  const fd = new FormData();
  fd.append("examQuestionId", step.id);
  fd.append("idempotencyKey", crypto.randomUUID());
  fd.append("durationMs", "12000");
  fd.append("fromStep", String(step.stepIndex));
  fd.append("wav", new Blob([wav], { type: "audio/wav" }), "a.wav");
  const submit = await req(`/api/speaking/sessions/${s2.id}/complete-answer`, { method: "POST", body: fd });
  if (submit.status !== 201 && submit.status !== 200) throw new Error(`submit status ${submit.status}`);
  const after = (await req(`/api/speaking/sessions/${s2.id}`)).body;
  const answered = after.steps.find((s) => s.id === step.id);
  if (!answered.answer) throw new Error("answer was not persisted");
});

const failed = checks.filter((c) => c[0] === "FAIL");
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
