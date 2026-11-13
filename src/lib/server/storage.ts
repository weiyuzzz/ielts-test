import { mkdir, writeFile, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** Local-disk audio storage. Swap for S3/OSS by re-implementing these three functions. */
const ROOT = path.resolve(process.env.AUDIO_STORAGE_DIR || path.join(process.cwd(), "storage", "audio"));

export async function saveAudio(buf: Buffer, ext: string) {
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const day = new Date().toISOString().slice(0, 10);
  const key = `${day}/${crypto.randomUUID()}.${ext.replace(/[^a-z0-9]/g, "")}`;
  const full = path.join(ROOT, key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buf);
  return { key, sha256 };
}

function safe(key: string) {
  const full = path.resolve(ROOT, key);
  if (!full.startsWith(ROOT + path.sep)) throw new Error("invalid storage key");
  return full;
}

export async function readAudio(key: string) {
  return readFile(safe(key));
}

export async function audioSize(key: string) {
  return (await stat(safe(key))).size;
}

export function extForMime(mime: string) {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a")) return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg")) return "mp3";
  return "bin";
}

/**
 * Non-destructive storage probe for the diagnostics centre: write a tiny marker
 * file under diagnostics/, read it back, verify the bytes and delete it. Real
 * exam audio is never touched. Throws nothing — the caller maps the result to a
 * DiagnosticItem.
 */
export async function probeAudioStorage(): Promise<{ ok: boolean; detail: string }> {
  const marker = `diagnostics/probe-${crypto.randomUUID()}.txt`;
  const payload = `band-nine storage probe ${new Date().toISOString()}`;
  try {
    const full = safe(marker);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, payload, "utf8");
    const back = await readFile(full, "utf8");
    if (back !== payload) return { ok: false, detail: "read-back content mismatch" };
    await unlink(full);
    return { ok: true, detail: `write/read/cleanup ok (${ROOT})` };
  } catch (e) {
    try { await unlink(safe(marker)); } catch { /* nothing to clean */ }
    return { ok: false, detail: (e as Error).message };
  }
}
