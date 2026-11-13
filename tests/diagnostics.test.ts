import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyProviderFailure, computeReadiness, inspectWavHeader, DIAGNOSTIC_IDS,
  type DiagnosticItem,
} from "../src/lib/diagnostics/types";
import { encodeWav } from "../src/lib/audio/wav";
import { ProviderError } from "../src/lib/ai/types";

// ------------------------------------------------------------------ helpers

function item(id: string, status: DiagnosticItem["status"], group: DiagnosticItem["group"] = "application"): DiagnosticItem {
  return { id, group, name: id, scope: "server", status, required: false, message: "" };
}

const GREEN_BROWSER: DiagnosticItem[] = [
  item(DIAGNOSTIC_IDS.browserRecordPlayback, "ready", "speech"),
  item(DIAGNOSTIC_IDS.browserWebSpeech, "ready", "speech"),
  item(DIAGNOSTIC_IDS.ttsAudition, "ready", "speech"),
];

// ------------------------------------------------------------------ classifyProviderFailure

test("diag: classifyProviderFailure maps provider codes to stable kinds", () => {
  const cfg = classifyProviderFailure("llm", new ProviderError("llm", "config", "missing API key"));
  assert.equal(cfg.status, "not_configured");
  assert.equal(cfg.kind, "not_configured");
  assert.ok(cfg.message.startsWith("[llm] config"));

  const timeout = classifyProviderFailure("llm", new ProviderError("llm", "timeout", "no response within 60000ms"));
  assert.equal(timeout.kind, "timeout");
  assert.equal(timeout.status, "failed");

  const key = classifyProviderFailure("llm", new ProviderError("llm", "http", "401 Incorrect API key provided"));
  assert.equal(key.kind, "key_invalid");
  assert.equal(key.status, "failed");

  assert.equal(classifyProviderFailure("llm", new ProviderError("llm", "http", "429 Too Many Requests")).kind, "rate_limited");
  assert.equal(classifyProviderFailure("llm", new ProviderError("llm", "http", "404 model gpt-x not found")).kind, "model_unavailable");
  assert.equal(classifyProviderFailure("llm", new ProviderError("llm", "invalid_response", "no content")).kind, "invalid_format");

  const serverErr = classifyProviderFailure("llm", new ProviderError("llm", "http", "502 bad gateway"));
  assert.equal(serverErr.status, "degraded");
});

test("diag: classifyProviderFailure redacts API keys from messages", () => {
  const r = classifyProviderFailure("llm", new Error("401 for key sk-abcdef1234567890abcdef1234567890"));
  assert.equal(r.message.includes("sk-abcdef1234567890abcdef1234567890"), false);
  assert.ok(r.message.includes("sk-abcdef…"));
});

test("diag: classifyProviderFailure survives non-Error input", () => {
  assert.equal(classifyProviderFailure("llm", "boom").status, "failed");
});

// ------------------------------------------------------------------ computeReadiness

test("diag: readiness — full green with 3D probe OK", () => {
  const items: DiagnosticItem[] = [
    item(DIAGNOSTIC_IDS.appDb, "ready"),
    item(DIAGNOSTIC_IDS.appBank, "ready"),
    item(DIAGNOSTIC_IDS.appSession, "ready"),
    item(DIAGNOSTIC_IDS.appStorage, "ready"),
    item(DIAGNOSTIC_IDS.ttsSynth, "ready"),
    item(DIAGNOSTIC_IDS.llmProbe, "ready", "ai"),
    item(DIAGNOSTIC_IDS.asrTranscribe, "ready", "speech"),
    item(DIAGNOSTIC_IDS.pronAssess, "ready", "pronunciation"),
    item(DIAGNOSTIC_IDS.gpuWebgl, "ready", "digital-human"),
    item(DIAGNOSTIC_IDS.gpuModelRender, "ready", "digital-human"),
    ...GREEN_BROWSER,
  ];
  const r = computeReadiness(items, { digitalHuman3d: true, deploymentTtsLocation: "server" });
  assert.equal(r.examReady, true);
  assert.equal(r.scoringReady, true);
  assert.equal(r.completeBandReady, true);
  assert.equal(r.digitalHumanReady, true);
  assert.equal(r.recommendedMode, "3d");
});

test("diag: readiness — broken server TTS blocks examReady even with browser audition", () => {
  const items: DiagnosticItem[] = [
    item(DIAGNOSTIC_IDS.appDb, "ready"),
    item(DIAGNOSTIC_IDS.appBank, "ready"),
    item(DIAGNOSTIC_IDS.appSession, "ready"),
    item(DIAGNOSTIC_IDS.ttsSynth, "failed"),
    item(DIAGNOSTIC_IDS.ttsAudition, "ready", "speech"),
    item(DIAGNOSTIC_IDS.browserRecordPlayback, "ready", "speech"),
    item(DIAGNOSTIC_IDS.llmProbe, "ready", "ai"),
    item(DIAGNOSTIC_IDS.asrTranscribe, "ready", "speech"),
    item(DIAGNOSTIC_IDS.appStorage, "ready"),
  ];
  const r = computeReadiness(items, { digitalHuman3d: false, deploymentTtsLocation: "server" });
  assert.equal(r.examReady, false);
  assert.ok(r.notes.some((n) => n.includes("examiner voice")));
});

test("diag: readiness — browser deployment accepts the browser audition", () => {
  const items: DiagnosticItem[] = [
    item(DIAGNOSTIC_IDS.appDb, "ready"),
    item(DIAGNOSTIC_IDS.appBank, "ready"),
    item(DIAGNOSTIC_IDS.appSession, "ready"),
    item(DIAGNOSTIC_IDS.ttsSynth, "not_tested"),
    item(DIAGNOSTIC_IDS.ttsAudition, "ready", "speech"),
    item(DIAGNOSTIC_IDS.browserRecordPlayback, "ready", "speech"),
    item(DIAGNOSTIC_IDS.appStorage, "ready"),
    item(DIAGNOSTIC_IDS.llmProbe, "ready", "ai"),
    item(DIAGNOSTIC_IDS.asrTranscribe, "ready", "speech"),
  ];
  const r = computeReadiness(items, { digitalHuman3d: false, deploymentTtsLocation: "browser" });
  assert.equal(r.examReady, true);
});

test("diag: readiness — no LLM keeps recording possible, scoring not ready, P omitted", () => {
  const items: DiagnosticItem[] = [
    item(DIAGNOSTIC_IDS.appDb, "ready"),
    item(DIAGNOSTIC_IDS.appBank, "ready"),
    item(DIAGNOSTIC_IDS.appSession, "ready"),
    item(DIAGNOSTIC_IDS.ttsSynth, "ready"),
    item(DIAGNOSTIC_IDS.browserRecordPlayback, "ready", "speech"),
    item(DIAGNOSTIC_IDS.llmProbe, "not_configured", "ai"),
    item(DIAGNOSTIC_IDS.asrTranscribe, "ready", "speech"),
    item(DIAGNOSTIC_IDS.appStorage, "ready"),
    item(DIAGNOSTIC_IDS.pronConfig, "not_configured", "pronunciation"),
  ];
  const r = computeReadiness(items, { digitalHuman3d: false, deploymentTtsLocation: "server" });
  assert.equal(r.examReady, true);
  assert.equal(r.scoringReady, false);
  assert.equal(r.completeBandReady, false);
  assert.ok(r.notes.some((n) => n.includes("unscored")));
  assert.ok(r.notes.some((n) => n.includes("P")));
});

test("diag: readiness — browser Web Speech substitutes for unavailable server ASR", () => {
  const items: DiagnosticItem[] = [
    item(DIAGNOSTIC_IDS.appDb, "ready"),
    item(DIAGNOSTIC_IDS.appBank, "ready"),
    item(DIAGNOSTIC_IDS.appSession, "ready"),
    item(DIAGNOSTIC_IDS.ttsSynth, "ready"),
    item(DIAGNOSTIC_IDS.browserRecordPlayback, "ready", "speech"),
    item(DIAGNOSTIC_IDS.browserWebSpeech, "ready", "speech"),
    item(DIAGNOSTIC_IDS.llmProbe, "ready", "ai"),
    item(DIAGNOSTIC_IDS.asrTranscribe, "failed", "speech"),
    item(DIAGNOSTIC_IDS.appStorage, "ready"),
  ];
  const r = computeReadiness(items, { digitalHuman3d: false, deploymentTtsLocation: "server" });
  assert.equal(r.scoringReady, true);
});

test("diag: readiness — 3D off never blocks examReady, recommends 2d", () => {
  const items: DiagnosticItem[] = [
    item(DIAGNOSTIC_IDS.appDb, "ready"),
    item(DIAGNOSTIC_IDS.appBank, "ready"),
    item(DIAGNOSTIC_IDS.appSession, "ready"),
    item(DIAGNOSTIC_IDS.ttsSynth, "ready"),
    item(DIAGNOSTIC_IDS.browserRecordPlayback, "ready", "speech"),
    item(DIAGNOSTIC_IDS.gpuWebgl, "failed", "digital-human"),
    item(DIAGNOSTIC_IDS.gpuModelRender, "disabled", "digital-human"),
  ];
  const r = computeReadiness(items, { digitalHuman3d: false, deploymentTtsLocation: "server" });
  assert.equal(r.examReady, true); // digital human state must not affect examReady
  assert.equal(r.digitalHumanReady, false);
  assert.equal(r.recommendedMode, "2d");
});

test("diag: readiness — low FPS render (degraded) recommends 2d with a note", () => {
  const items: DiagnosticItem[] = [
    item(DIAGNOSTIC_IDS.appDb, "ready"),
    item(DIAGNOSTIC_IDS.appBank, "ready"),
    item(DIAGNOSTIC_IDS.appSession, "ready"),
    item(DIAGNOSTIC_IDS.ttsSynth, "ready"),
    item(DIAGNOSTIC_IDS.browserRecordPlayback, "ready", "speech"),
    item(DIAGNOSTIC_IDS.gpuWebgl, "ready", "digital-human"),
    item(DIAGNOSTIC_IDS.gpuModelRender, "degraded", "digital-human"),
  ];
  const r = computeReadiness(items, { digitalHuman3d: true, deploymentTtsLocation: "server" });
  assert.equal(r.digitalHumanReady, false);
  assert.equal(r.recommendedMode, "2d");
  assert.ok(r.notes.some((n) => n.includes("2D")));
});

// ------------------------------------------------------------------ inspectWavHeader

test("diag: inspectWavHeader accepts 16 kHz mono PCM (the exam capture format)", () => {
  const wav = encodeWav(new Float32Array(16000), 16000);
  const r = inspectWavHeader(wav);
  assert.equal(r.ok, true);
  assert.equal(r.sampleRate, 16000);
  assert.equal(r.channels, 1);
});

test("diag: inspectWavHeader rejects wrong rate / channels", () => {
  const wrongRate = inspectWavHeader(encodeWav(new Float32Array(44100), 44100));
  assert.equal(wrongRate.ok, false);
  assert.ok(wrongRate.detail.includes("44100"));
  const tooSmall = inspectWavHeader(new Uint8Array(10));
  assert.equal(tooSmall.ok, false);
});
