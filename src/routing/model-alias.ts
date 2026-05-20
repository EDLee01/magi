import { MagiConfig } from "../config.js";
import { MagiConfigError } from "../errors.js";

export interface ResolvedModel {
  providerName: string;
  model: string;
  source: string;
}

export function resolveModelAlias(config: MagiConfig, nameOrRef: string): ResolvedModel {
  const source = nameOrRef.trim();
  if (!source) {
    throw new MagiConfigError("Model alias or reference must not be empty");
  }

  const target = config.models.aliases[source] ?? source;
  const [providerName, model] = splitModelRef(target);
  return { providerName, model, source };
}

export function resolveFallbackChain(config: MagiConfig, alias: string): ResolvedModel[] {
  const primary = resolveModelAlias(config, alias);
  const fallbackRefs = config.models.fallbacks[alias] ?? [];
  return [primary, ...fallbackRefs.map((ref) => resolveModelAlias(config, ref))];
}

function splitModelRef(value: string): [string, string] {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new MagiConfigError(`Model reference ${JSON.stringify(value)} must use provider:model`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}
