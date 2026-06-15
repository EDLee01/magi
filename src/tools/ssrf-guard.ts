import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { ToolError } from "./errors.js";

/**
 * SSRF guard. Blocks requests that resolve to loopback, link-local, private,
 * or otherwise internal addresses — most importantly the cloud metadata
 * endpoint 169.254.169.254, which can hand out IAM credentials.
 *
 * Set MAGI_ALLOW_INTERNAL_REQUESTS=1 to opt out (e.g. for local development
 * against 127.0.0.1).
 */

export function internalRequestsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.MAGI_ALLOW_INTERNAL_REQUESTS;
  return flag === "1" || flag === "true";
}

/** True if the given IP literal (v4 or v6) points at an internal/reserved range. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed → fail closed
  }
  const [a, b] = parts;
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a >= 224) return true; // multicast + reserved 224.0.0.0/3
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4 address.
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
}

/**
 * Validate a URL's destination is not internal. Resolves DNS so a hostname
 * that points at an internal IP (DNS rebinding / *.localtest.me style) is also
 * caught. Throws ToolError when blocked. No-op when internal requests are
 * explicitly allowed.
 */
export interface AssertUrlOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Optional predicate for hosts the caller has explicitly allowlisted. When it
   * returns true for the URL's hostname, the internal-address check is skipped
   * for that host — e.g. a user who allowlisted 127.0.0.1 for WebFetch. Note
   * redirect hops are validated individually, so a redirect to a *different*,
   * non-allowlisted internal address is still blocked.
   */
  allowHost?: (hostname: string) => boolean;
}

export async function assertUrlAllowed(
  rawUrl: string,
  options: AssertUrlOptions = {}
): Promise<void> {
  const env = options.env ?? process.env;
  if (internalRequestsAllowed(env)) return;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolError(`Invalid URL: ${rawUrl}`, "bad-input");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (options.allowHost?.(host)) return;

  // Obvious hostname-based blocks before any DNS lookup.
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw blocked(host);
  }

  // IP literal → check directly.
  if (isIP(host)) {
    if (isBlockedIp(host)) throw blocked(host);
    return;
  }

  // Hostname → resolve every address and reject if any is internal.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new ToolError(`Could not resolve host: ${host}`, "not-found");
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) throw blocked(`${host} (${address})`);
  }
}

function blocked(target: string): ToolError {
  return new ToolError(
    `Refusing to connect to internal address: ${target}. Set MAGI_ALLOW_INTERNAL_REQUESTS=1 to override.`,
    "bad-input"
  );
}
