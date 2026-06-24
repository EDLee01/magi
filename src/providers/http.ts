import { ProviderConfig } from "../config.js";
import { MagiConfigError } from "../errors.js";
import { providerErrorFromException } from "./errors.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Default overall request timeout (ms) when a provider does not set its own.
 * Tunable via MAGI_PROVIDER_TIMEOUT_MS. This guards against an endpoint that
 * accepts the connection but never responds (the undici connect timeout only
 * covers the TCP/TLS handshake, not a silent server). A generous default
 * leaves room for slow, cold-starting proxies.
 */
export function resolveProviderTimeoutMs(
  config: { timeoutMs?: number },
  env: NodeJS.ProcessEnv = process.env
): number {
  if (typeof config.timeoutMs === "number" && config.timeoutMs > 0) {
    return config.timeoutMs;
  }
  const raw = env.MAGI_PROVIDER_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

/**
 * Combine an optional caller signal with a timeout so a slow/dead endpoint
 * aborts on its own. Returns the merged signal plus a cleanup to clear the
 * timer once the request settles.
 */
function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer)
  };
}

export async function fetchProvider(
  providerName: string,
  fetchImpl: FetchLike,
  input: string | URL,
  init?: RequestInit,
  options?: { timeoutMs?: number }
): Promise<Response> {
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs === undefined || timeoutMs <= 0) {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      throw providerErrorFromException(providerName, error);
    }
  }
  const { signal, cleanup } = withTimeoutSignal(init?.signal ?? undefined, timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal });
  } catch (error) {
    throw providerErrorFromException(providerName, error);
  } finally {
    cleanup();
  }
}

export function getApiKey(
  providerName: string,
  config: ProviderConfig,
  env: NodeJS.ProcessEnv
): string {
  const envName = config.apiKeyEnv ?? "MAGI_OPENAI_API_KEY";
  const value = env[envName];
  if (!value) {
    throw new MagiConfigError(
      [
        `Provider "${providerName}" needs the environment variable ${envName} to be set.`,
        "",
        "Quick fix:",
        `  export ${envName}="<your-key>"`,
        "",
        `Or add to your shell profile (~/.zshrc or ~/.bashrc) so it persists.`,
        `Run 'magi doctor' to verify the configuration.`
      ].join("\n")
    );
  }
  return value;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
