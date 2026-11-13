/**
 * Externally-managed TTS engine services (the app does NOT own their process).
 *
 * Kokoro runs under an OS supervisor (Windows NSSM / macOS launchd — see
 * docs/tts-engine-deployment.md). A "restart" button may only exist when the
 * operator explicitly configured WHICH supervisor manages the engine, via:
 *
 *   TTS_SERVICE_MANAGER=nssm|launchd     (required — the permission gate)
 *   TTS_SERVICE_NAME=KokoroTTS           (nssm service name; default KokoroTTS)
 *   TTS_SERVICE_LABEL=com.ielts.kokoro-tts (launchd label; default from docs)
 *
 * Security rules enforced here:
 *  - fixed service-ID whitelist (no user input reaches a command line);
 *  - command + arguments are literals built from server-side env only;
 *  - execFile (no shell), so injection is impossible by construction;
 *  - every attempt is audit-logged to storage/logs/service-restart.log;
 *  - without a configured manager, restart() returns `unavailable` and the UI
 *    shows the manual steps from the deployment doc — never a fake success.
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type ServiceManager = "nssm" | "launchd";

export interface ManagedService {
  id: string;
  label: string;
  manager: ServiceManager | null;
  restartable: boolean;
  healthUrl: string | null;
  /** Fixed command for audit display (never executed with user input). */
  command: string | null;
}

const KOKORO_ID = "kokoro-tts";

/** The engine base URL the TTS provider actually uses ("" when not Kokoro-like). */
function kokoroBaseUrl(): string {
  const base = (process.env.TTS_BASE_URL || process.env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  const model = process.env.TTS_MODEL || "";
  if (!base) return "";
  if (/kokoro/i.test(base) || /^kokoro/i.test(model)) return base.replace(/\/v1\/?$/, "");
  return "";
}

export function configuredManager(): ServiceManager | null {
  const m = (process.env.TTS_SERVICE_MANAGER || "").trim().toLowerCase();
  return m === "nssm" ? "nssm" : m === "launchd" ? "launchd" : null;
}

function restartCommand(manager: ServiceManager): { cmd: string; args: string[] } | null {
  if (manager === "nssm") {
    const name = (process.env.TTS_SERVICE_NAME || "KokoroTTS").trim();
    return { cmd: "nssm", args: ["restart", name] };
  }
  if (manager === "launchd") {
    const label = (process.env.TTS_SERVICE_LABEL || "com.ielts.kokoro-tts").trim();
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    return { cmd: "launchctl", args: ["kickstart", "-k", `gui/${uid}/${label}`] };
  }
  return null;
}

/** Public, secret-free view for the diagnostics API. */
export function managedServices(): ManagedService[] {
  const base = kokoroBaseUrl();
  const manager = configuredManager();
  const cmd = manager ? restartCommand(manager) : null;
  return [
    {
      id: KOKORO_ID,
      label: "Kokoro TTS engine",
      manager,
      restartable: !!cmd,
      healthUrl: base ? `${base}/health` : null,
      command: cmd ? `${cmd.cmd} ${cmd.args.join(" ")}` : null,
    },
  ];
}

/** GET /health with a short timeout. localhost/local-network only by construction. */
export async function probeServiceHealth(serviceId: string): Promise<{ healthy: boolean; detail: string; latencyMs?: number }> {
  if (serviceId !== KOKORO_ID) return { healthy: false, detail: "unknown service" };
  const base = kokoroBaseUrl();
  if (!base) return { healthy: false, detail: "No Kokoro engine is configured (TTS_BASE_URL does not point at a Kokoro engine)." };
  const url = `${base}/health`;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const body = (await res.text().catch(() => "")).slice(0, 200);
    const latencyMs = Date.now() - t0;
    return res.ok
      ? { healthy: true, detail: `${res.status} ${body || "ok"}`, latencyMs }
      : { healthy: false, detail: `health endpoint answered ${res.status}`, latencyMs };
  } catch (e) {
    return { healthy: false, detail: `health endpoint unreachable (${(e as Error).message})` };
  } finally {
    clearTimeout(timer);
  }
}

async function auditLog(entry: Record<string, unknown>): Promise<void> {
  try {
    const dir = path.join(process.cwd(), "storage", "logs");
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "service-restart.log"), `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`, "utf8");
  } catch { /* auditing must never break the request */ }
}

function exec(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number | null }).code === "number" ? (err as { code: number }).code : err ? -1 : 0;
      resolve({ code, stdout: String(stdout ?? "").slice(0, 500), stderr: String(stderr ?? "").slice(0, 500) });
    });
  });
}

export interface RestartOutcome {
  ok: boolean;
  phase: "restarted" | "warming-up" | "unavailable";
  detail: string;
}

/**
 * Restart a whitelisted service. Returns phase "restarted" only when the
 * supervisor command succeeded AND the engine answers /health again within the
 * warm-up window — otherwise "warming-up" (honest: command ran, engine still
 * starting) or "unavailable" (nothing was executed).
 */
export async function restartManagedService(serviceId: string, actor: string): Promise<RestartOutcome> {
  if (serviceId !== KOKORO_ID) {
    await auditLog({ serviceId, actor, allowed: false, reason: "not in whitelist" });
    return { ok: false, phase: "unavailable", detail: "Unknown service id." };
  }
  const manager = configuredManager();
  const cmd = manager ? restartCommand(manager) : null;
  if (!manager || !cmd) {
    await auditLog({ serviceId, actor, allowed: false, reason: "no service manager configured" });
    return {
      ok: false,
      phase: "unavailable",
      detail: "No service manager is configured on this host, so the app cannot restart the engine itself. Follow docs/tts-engine-deployment.md: Windows → `nssm restart KokoroTTS` (set TTS_SERVICE_MANAGER=nssm to enable the button); macOS → `launchctl kickstart -k gui/$(id -u)/com.ielts.kokoro-tts`.",
    };
  }
  const r = await exec(cmd.cmd, cmd.args);
  await auditLog({ serviceId, actor, allowed: true, manager, cmd: `${cmd.cmd} ${cmd.args.join(" ")}`, exitCode: r.code, stderr: r.stderr || undefined });
  if (r.code !== 0) {
    return { ok: false, phase: "unavailable", detail: `Restart command failed (exit ${r.code}). ${r.stderr || r.stdout || "See storage/logs/service-restart.log."}` };
  }
  // The engine needs a model warm-up window; poll health instead of faking success.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const h = await probeServiceHealth(serviceId);
    if (h.healthy) return { ok: true, phase: "restarted", detail: `Engine is answering again (${h.latencyMs ?? 0} ms).` };
    if (Date.now() > deadline) {
      return { ok: true, phase: "warming-up", detail: `Restart command succeeded (exit 0), but ${KOKORO_ID} has not answered /health within 90 s — it is probably still loading the model. Check the engine logs.` };
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
}
