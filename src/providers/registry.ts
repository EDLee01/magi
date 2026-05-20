import { MagiConfig, ProviderConfig } from "../config.js";
import { FetchLike } from "./http.js";
import { ProviderAdapter } from "./ir.js";
import { MessagesCompatibleAdapter } from "./messages-compatible.js";
import { OpenAiAdapter } from "./openai.js";

export type ProviderRegistry = Map<string, ProviderAdapter>;

export function buildProviderRegistry(input: {
  config: MagiConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}): ProviderRegistry {
  const registry: ProviderRegistry = new Map();
  for (const [name, provider] of Object.entries(input.config.providers)) {
    registry.set(name, createProviderAdapter(name, provider, input.env, input.fetchImpl));
  }
  return registry;
}

export function createProviderAdapter(
  name: string,
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike
): ProviderAdapter {
  if (config.type === "openai") {
    return new OpenAiAdapter({ name, config, env, fetchImpl });
  }
  return new MessagesCompatibleAdapter({ name, config, env, fetchImpl });
}
