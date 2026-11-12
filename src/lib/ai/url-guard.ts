/**
 * Outbound endpoint guard for server-side AI provider requests.
 *
 * The OpenAI-compatible providers take their base URL from environment
 * variables / the /admin sidecar. That is deployment configuration, but it is
 * still a server-side fetch to a configurable URL, so it is guarded:
 *   - only http/https;
 *   - no userinfo credentials in the URL;
 *   - hostnames that resolve to loopback / private / link-local / reserved
 *     ranges are rejected (metadata endpoints included);
 *   - deployments that deliberately run local engines (vLLM, Kokoro) can opt
 *     out with ALLOW_LOCAL_AI_ENDPOINTS=1 — documented, explicit, per-deploy.
 */
import dns from "node:dns/promises";

const PRIVATE_V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4InBlock(ip: string, base: string, bits: number): boolean {
  const toInt = (s: string) =>
    s.split(".").reduce((acc, o) => acc * 256 + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

function isPrivateIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  // IPv6: loopback, link-local (fe80::/10), unique-local (fc00::/7), 0.0.0.0
  if (h.includes(":")) {
    if (h === "::" || h === "::1" || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb") || h.startsWith("fc") || h.startsWith("fd")) return true;
    // IPv4-mapped ::ffff:a.b.c.d
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped && isPrivateIpLiteral(mapped[1])) return true;
    return false;
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
  return PRIVATE_V4_BLOCKS.some(([base, bits]) => v4InBlock(h, base, bits));
}

const HOSTNAME_DENY = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /^metadata\.google\.internal$/i,
  /^metadata\.goog$/i,
  /^instance-data/i,
];

export interface EndpointGuardOptions {
  /** Permit loopback/private endpoints (self-hosted vLLM/Kokoro deployments). */
  allowLocal?: boolean;
}

/** True when the deployment explicitly opted into local AI endpoints. */
export function allowLocalAiEndpoints(): boolean {
  return process.env.ALLOW_LOCAL_AI_ENDPOINTS === "1";
}

const dnsCache = new Map<string, { ok: boolean; expires: number }>();
const DNS_TTL_MS = 30_000;

/**
 * Validate a server-side endpoint BEFORE any request and return the final
 * request URL (base + path). Throws a descriptive error; callers turn it into
 * a ProviderError.
 */
export async function assertSafeEndpoint(rawUrl: string, path = ""): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`invalid endpoint URL: ${rawUrl.slice(0, 120)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`endpoint scheme must be http(s): ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("endpoint URL must not embed credentials");
  }
  const host = url.hostname.toLowerCase();
  const deny = HOSTNAME_DENY.some((re) => re.test(host)) || isPrivateIpLiteral(host);
  const allowLocal = allowLocalAiEndpoints();
  if (deny && !allowLocal) {
    throw new Error(`endpoint host is not allowed: ${host} (set ALLOW_LOCAL_AI_ENDPOINTS=1 to permit self-hosted engines)`);
  }
  // DNS layer: a hostname may still resolve into a private range.
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(":")) {
    const cached = dnsCache.get(host);
    if (cached && cached.expires > Date.now()) {
      if (!cached.ok) throw new Error(`endpoint host resolves to a forbidden address: ${host}`);
    } else {
      let ok = true;
      try {
        const addrs = await dns.lookup(host, { all: true });
        ok = addrs.every((a) => !isPrivateIpLiteral(a.address));
      } catch {
        ok = false; // unresolvable hostnames are refused, not ignored
      }
      dnsCache.set(host, { ok, expires: +Date.now() + DNS_TTL_MS });
      if (!ok) throw new Error(`endpoint host resolves to a forbidden address: ${host}`);
    }
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}${path}`;
}
