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

  constructor(message: string, input: { kind: ProviderFailureKind; status?: number; retryable?: boolean }) {
    super(message);
    this.name = "ProviderError";
    this.kind = input.kind;
    this.status = input.status;
    this.retryable = input.retryable ?? isRetryableFailure(input.kind);
  }
}

export function isRetryableFailure(kind: ProviderFailureKind): boolean {
  return kind === "timeout" || kind === "rate-limit" || kind === "server-error" || kind === "model-unavailable";
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

function formatProviderErrorMessage(providerName: string, status: number, kind: ProviderFailureKind): string {
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
      return `${base} (network error). Check your internet connection and the provider's baseUrl.`;
    default:
      return `${base}.`;
  }
}
