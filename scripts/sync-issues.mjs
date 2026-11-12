#!/usr/bin/env node
/**
 * Sync the issue drafts in docs/issues/ to GitHub.
 *
 *   GITHUB_TOKEN=... node scripts/sync-issues.mjs            # archive/delete old, create missing
 *   GITHUB_TOKEN=... node scripts/sync-issues.mjs --dry-run  # parse + print, no writes
 *
 * Env:
 *   GITHUB_TOKEN / GH_TOKEN   required (repo scope; classic or fine-grained with Issues: RW)
 *   REPO                      default weiyuzzz/ielts-test
 *   OLD_ISSUE                 issue number to retire, default 1; set to 0 to skip
 *   DELETE_OLD                1 = hard delete via GraphQL, 0 = close + rename, default 1
 *
 * Idempotent: an issue whose title already exists is skipped.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.REPO || "weiyuzzz/ielts-test";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const OLD_ISSUE = Number(process.env.OLD_ISSUE ?? "1");
const DELETE_OLD = (process.env.DELETE_OLD ?? "1") === "1";
const DRY = process.argv.includes("--dry-run");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "docs", "issues");

if (!DRY && !TOKEN) {
  console.error("error: set GITHUB_TOKEN (repo scope) or pass --dry-run");
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const e = new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json).slice(0, 400));
  return json.data;
}

/** Markdown draft -> { title, labels, body }. Title = line 1, labels = <!-- labels: a, b -->. */
function parseDraft(raw) {
  const lines = raw.split("\n");
  const title = lines[0].replace(/^#\s+/, "").trim();
  const labelLine = lines.slice(0, 6).find((l) => l.includes("labels:"));
  const labels = labelLine
    ? labelLine.replace(/.*labels:\s*/, "").replace(/-->.*/, "").split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const body = lines.filter((l, i) => i > 0 && !l.includes("labels:")).join("\n").trim();
  return { title, labels, body };
}

async function loadDrafts() {
  const files = (await readdir(DIR)).filter((f) => /^new-\d+.*\.md$/.test(f)).sort();
  const out = [];
  for (const f of files) out.push({ file: f, ...parseDraft(await readFile(join(DIR, f), "utf8")) });
  return out;
}

async function listIssueTitles() {
  const titles = new Set();
  for (let page = 1; page <= 5; page++) {
    const batch = await api(`/repos/${REPO}/issues?state=all&per_page=100&page=${page}`);
    for (const it of batch) if (!it.pull_request) titles.add(it.title);
    if (batch.length < 100) break;
  }
  return titles;
}

async function ensureLabel(name, color) {
  try {
    await api(`/repos/${REPO}/labels`, { method: "POST", body: JSON.stringify({ name, color }) });
    console.log(`  label created: ${name}`);
  } catch (e) {
    if (e.status !== 422) throw e; // 422 = already exists
  }
}

const LABELS = [
  ["content", "0E8A16"], ["voice", "1D76DB"], ["scoring", "FBCA04"],
  ["infra", "5319E7"], ["test", "BFD4F2"], ["enhancement", "A2EEEF"],
  ["help wanted", "008672"], ["bug", "D73A4A"],
];

/** Retire the old tracking issue: hard delete when possible, else close + rename. */
async function retireOldIssue() {
  if (!OLD_ISSUE) return;
  let issue;
  try {
    issue = await api(`/repos/${REPO}/issues/${OLD_ISSUE}`);
  } catch (e) {
    if (e.status === 404) { console.log(`  #${OLD_ISSUE} not found, nothing to retire`); return; }
    throw e;
  }
  if (issue.state === "closed" && /^\[已归档\]/.test(issue.title)) {
    console.log(`  #${OLD_ISSUE} already archived, skip`);
    return;
  }
  if (DELETE_OLD) {
    try {
      await graphql(
        "mutation($id:ID!){ deleteIssue(input:{issueId:$id}) { clientMutationId } }",
        { id: issue.node_id },
      );
      console.log(`  #${OLD_ISSUE} deleted (content folded into the new issues)`);
      return;
    } catch (e) {
      console.log(`  delete failed (${String(e.message).slice(0, 120)}), closing instead`);
    }
  }
  await api(`/repos/${REPO}/issues/${OLD_ISSUE}`, {
    method: "PATCH",
    body: JSON.stringify({
      state: "closed",
      title: `[已归档] ${issue.title}`.slice(0, 250),
      body: `> 本 issue 已归档。已修复内容见 \`docs/phase2-examiner-voice.md\` 的合并记录，\n> 仍未完成的事项拆分到新 issue（Phase 1 浏览器验收、三引擎实机验证、预置音频、CI）。\n\n---\n\n${issue.body ?? ""}`,
    }),
  });
  console.log(`  #${OLD_ISSUE} closed and renamed to [已归档]`);
}

async function main() {
  const drafts = await loadDrafts();
  console.log(`repo: ${REPO}`);
  console.log(`drafts: ${drafts.length}`);
  for (const d of drafts) {
    console.log(`  - ${d.file}  [${d.labels.join(", ")}]  ${d.title.slice(0, 60)}`);
    if (!d.title || !d.body) throw new Error(`draft ${d.file} is missing a title or body`);
  }
  if (DRY) { console.log("dry-run: no changes made"); return; }

  console.log("retiring old issue:");
  await retireOldIssue();

  console.log("labels:");
  for (const [name, color] of LABELS) await ensureLabel(name, color);

  console.log("creating issues:");
  const existing = await listIssueTitles();
  for (const d of drafts) {
    if (existing.has(d.title)) { console.log(`  skip (exists): ${d.title.slice(0, 60)}`); continue; }
    const created = await api(`/repos/${REPO}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: d.title, body: d.body, labels: d.labels }),
    });
    console.log(`  #${created.number} ${created.html_url}`);
  }
  console.log(`done: https://github.com/${REPO}/issues`);
}

main().catch((e) => { console.error(`failed: ${e.message}`); process.exit(1); });
