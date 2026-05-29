import { ProviderConfig } from "../config.js";
import { MagiConfigError } from "../errors.js";
import { providerErrorFromException } from "./errors.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function fetchProvider(
  providerName: string,
  fetchImpl: FetchLike,
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (error) {
    throw providerErrorFromException(providerName, error);
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
