export type ProviderFailureKind =
  | "timeout"
  | "rate-limit"
  | "server-error"
  | "model-unavailable"
  | "auth"
  | "bad-request"
  | "network"
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    input: { kind: ProviderFailureKind; status?: number; retryable?: boolean }
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = input.kind;
    this.status = input.status;
    this.retryable = input.retryable ?? isRetryableFailure(input.kind);
  }
}

export function isRetryableFailure(kind: ProviderFailureKind): boolean {
  return (
    kind === "timeout" ||
    kind === "rate-limit" ||
    kind === "server-error" ||
    kind === "model-unavailable" ||
    kind === "network"
  );
}

export function classifyHttpStatus(status: number): ProviderFailureKind {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 408) {
    return "timeout";
  }
  if (status === 429) {
    return "rate-limit";
  }
  if (status === 404) {
    return "model-unavailable";
  }
  if (status >= 500) {
    return "server-error";
  }
  if (status >= 400) {
    return "bad-request";
  }
  return "unknown";
}

export function providerErrorFromResponse(providerName: string, response: Response): ProviderError {
  const kind = classifyHttpStatus(response.status);
  const message = formatProviderErrorMessage(providerName, response.status, kind);
  return new ProviderError(message, {
    kind,
    status: response.status
  });
}

function formatProviderErrorMessage(
  providerName: string,
  status: number,
  kind: ProviderFailureKind
): string {
  const base = `${providerName} returned HTTP ${status}`;
  switch (kind) {
    case "auth":
      return `${base} (authentication failed). Check your API key (${providerName === "anthropic" ? "ANTHROPIC_AUTH_TOKEN" : "provider's apiKeyEnv setting"}). Run 'magi doctor' to verify.`;
    case "rate-limit":
      return `${base} (rate limit). Will retry with backoff. If this persists, you've hit the provider's quota.`;
    case "server-error":
      return `${base} (server error, likely transient). Will retry. If it keeps failing, check the provider's status page or your proxy/baseUrl setting.`;
    case "timeout":
      return `${base} (timed out). Will retry. Slow responses often mean the proxy is overloaded or your network is slow.`;
    case "model-unavailable":
      return `${base} (model not found). The model name may be wrong or unavailable. Run '/model' to see configured aliases, or check provider docs for current model names.`;
    case "bad-request":
      return `${base} (bad request). The request shape was rejected — likely a config issue or unsupported parameter for this model.`;
    case "network":
      return `${base} (network error, likely transient). Will retry. Check your internet connection and the provider's baseUrl if it persists.`;
    default:
      return `${base}.`;
  }
}

export function providerErrorFromException(providerName: string, error: unknown): unknown {
  if (error instanceof ProviderError || isAbortError(error)) {
    return error;
  }
  if (!isLikelyNetworkError(error)) {
    return error;
  }
  const detail = errorDetail(error);
  return new ProviderError(
    `${providerName} request failed (network error, likely transient). Will retry.${detail ? ` ${detail}` : ""}`,
    {
      kind: "network",
      retryable: true
    }
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function isLikelyNetworkError(error: unknown): boolean {
  const text = errorDetail(error);
  return /fetch failed|failed to fetch|network|socket|connection|terminated|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(
    text
  );
}

/**
 * True for network failures that will NOT recover by retrying the same
 * endpoint: connection refused (closed port), host/DNS not found, or an
 * invalid URL. These should fail fast instead of burning the full retry
 * budget. Transient failures (timeouts, resets, cold-start TTFB) are NOT
 * fast-fail and should be retried generously.
 */
export function isFastFailNetworkError(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.message} ${errorDetail(error)}` : errorDetail(error);
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_INVALID_URL|bad port|invalid url|certificate/i.test(
    text
  );
}

function errorDetail(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.message) parts.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    if (
      typeof current === "object" &&
      current !== null &&
      "message" in current &&
      typeof (current as { message?: unknown }).message === "string"
    ) {
      parts.push((current as { message: string }).message);
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    parts.push(String(current));
    break;
  }
  return parts.filter(Boolean).join(": ");
}
