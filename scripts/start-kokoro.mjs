// Start the local Kokoro-FastAPI TTS engine on 0.0.0.0:8880 (GPU if available).
// Models and venv are already installed under D:\tts\Kokoro-FastAPI; this just
// starts the server with the right env, without re-running pip/model download.
// Keeps the process alive so the IELTS app can synthesize examiner speech.
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const ENGINE_DIR = "D:\\tts\\Kokoro-FastAPI";
const VENV_DIR = path.join(ENGINE_DIR, ".venv");
const PORT = 8880;

if (!fs.existsSync(path.join(ENGINE_DIR, "api", "src", "main.py"))) {
  console.error(`[kokoro] Engine not found at ${ENGINE_DIR} — see docs/tts-engine-deployment.md`);
  process.exit(1);
}
const uvicorn = path.join(VENV_DIR, "Scripts", "uvicorn.exe");
if (!fs.existsSync(uvicorn)) {
  console.error(`[kokoro] venv uvicorn not found at ${uvicorn}`);
  process.exit(1);
}

const env = {
  ...process.env,
  PHONEMIZER_ESPEAK_LIBRARY: "C:\\Program Files\\eSpeak NG\\libespeak-ng.dll",
  PYTHONUTF8: "1",
  PROJECT_ROOT: ENGINE_DIR,
  PYTHONPATH: `${ENGINE_DIR};${path.join(ENGINE_DIR, "api")}`,
  MODEL_DIR: "src/models",
  VOICES_DIR: "src/voices/v1_0",
  WEB_PLAYER_PATH: path.join(ENGINE_DIR, "web"),
  USE_GPU: "true",
};

console.log(`[kokoro] Starting Kokoro-FastAPI on 0.0.0.0:${PORT} (GPU) ...`);
const child = spawn(uvicorn, ["api.src.main:app", "--host", "0.0.0.0", "--port", String(PORT)], {
  cwd: ENGINE_DIR,
  env,
  stdio: "inherit",
});

child.on("error", (err) => {
  console.error("[kokoro] Failed to start:", err);
  process.exit(1);
});
child.on("exit", (code) => {
  console.log(`[kokoro] Engine exited with code ${code}`);
  process.exit(code ?? 0);
});

const shutdown = () => {
  console.log("[kokoro] Stopping engine...");
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
