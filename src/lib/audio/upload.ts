"use client";

export class UploadError extends Error {
  constructor(public status: number, message: string, public code?: string, public retryable = false) {
    super(message);
  }
}

/** Pure retry policy — unit-testable without XMLHttpRequest. */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429 || status === 0;
}

/** Bounded exponential backoff, capped at 8 s. */
export function backoffDelay(attempt: number): number {
  return Math.min(8000, 800 * 2 ** Math.max(0, attempt - 1));
}

function sendOnce(url: string, form: FormData, onProgress?: (p: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = 120000;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body: { error?: string; code?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new UploadError(xhr.status, body.error || `Upload failed (${xhr.status})`, body.code, isRetryableStatus(xhr.status)));
    };
    xhr.onerror = () => reject(new UploadError(0, "Network error during upload", "network", true));
    xhr.ontimeout = () => reject(new UploadError(0, "Upload timed out", "timeout", true));
    xhr.send(form);
  });
}

/** Upload with progress and exponential-backoff retry. The idempotency key in `form` makes retries safe. */
export async function uploadWithRetry<T>(url: string, form: FormData, opts: { onProgress?: (p: number) => void; onRetry?: (attempt: number, err: UploadError) => void; attempts?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  let last: UploadError | null = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return (await sendOnce(url, form, opts.onProgress)) as T;
    } catch (e) {
      last = e as UploadError;
      if (!last.retryable || i === attempts) break;
      opts.onRetry?.(i, last);
      await new Promise((r) => setTimeout(r, backoffDelay(i)));
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        await new Promise<void>((r) => {
          const on = () => {
            window.removeEventListener("online", on);
            r();
          };
          window.addEventListener("online", on);
          setTimeout(on, 30000);
        });
      }
    }
  }
  throw last ?? new UploadError(0, "Upload failed");
}

export async function postJson<T>(url: string, body: unknown = {}): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new UploadError(res.status, (j as { error?: string }).error || `Request failed (${res.status})`, (j as { code?: string }).code, res.status >= 500);
  return j as T;
}
