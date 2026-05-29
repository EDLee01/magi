import { MagiConfig } from "../config.js";
import { MagiConfigError } from "../errors.js";
import { ProviderError } from "../providers/errors.js";
import { ProviderRegistry } from "../providers/registry.js";
import {
  MagiMessage,
  MagiToolDefinition,
  ProviderRequest,
  ProviderResponse
} from "../providers/ir.js";
import { ResolvedModel, resolveFallbackChain } from "./model-alias.js";

export interface RouteAttempt {
  providerName: string;
  model: string;
  ok: boolean;
  errorKind?: string;
}

export interface RoutedResponse {
  response: ProviderResponse;
  providerName: string;
  model: string;
  attempts: RouteAttempt[];
}

export async function routeProviderRequest(input: {
  config: MagiConfig;
  registry: ProviderRegistry;
  alias: string;
  messages: MagiMessage[];
  tools?: MagiToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): Promise<RoutedResponse> {
  const candidates = resolveFallbackChain(input.config, input.alias);
  const attempts: RouteAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const adapter = input.registry.get(candidate.providerName);
    if (!adapter) {
      throw new MagiConfigError(`Provider ${candidate.providerName} is not configured`);
    }

    try {
      const response = await adapter.complete(toProviderRequest(candidate, input.messages, input));
      attempts.push({ providerName: candidate.providerName, model: candidate.model, ok: true });
      return {
        response,
        providerName: candidate.providerName,
        model: candidate.model,
        attempts
      };
    } catch (error) {
      lastError = error;
      if (error instanceof ProviderError) {
        attempts.push({
          providerName: candidate.providerName,
          model: candidate.model,
          ok: false,
          errorKind: error.kind
        });
        if (error.retryable) {
          continue;
        }
      }
      throw error;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new MagiConfigError(`No route candidates available for ${input.alias}`);
}

export function hasProviderRoute(config: MagiConfig, alias: string): boolean {
  try {
    const [primary] = resolveFallbackChain(config, alias);
    return config.providers[primary.providerName] !== undefined;
  } catch {
    return false;
  }
}

function toProviderRequest(
  candidate: ResolvedModel,
  messages: MagiMessage[],
  input: {
    tools?: MagiToolDefinition[];
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }
): ProviderRequest {
  return {
    model: candidate.model,
    messages,
    tools: input.tools,
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    signal: input.signal
  };
}
