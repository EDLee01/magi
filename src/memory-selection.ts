/**
 * LLM-based memory relevance selection.
 * When a selectionModel is configured, uses a fast model to pick ≤N most relevant memories.
 * Falls back to keyword-based searchMemory when no model is available.
 */

import { ProviderAdapter, ProviderRequest, textMessage } from "./providers/ir.js";
import {
  MemoryEntry,
  MemorySearchResult,
  listMemoryEntries,
  searchMemory,
  formatMemorySearchResults
} from "./memory.js";
import { MagiPaths } from "./paths.js";
import { MemoryScope } from "./memory.js";

export interface MemorySelectionRoute {
  adapter: ProviderAdapter;
  model: string;
  providerName: string;
}

export interface SelectMemoryInput {
  paths: MagiPaths;
  cwd: string;
  sessionId?: string;
  scopes?: MemoryScope[];
  maxResults: number;
  prompt: string;
  selectionRoute?: MemorySelectionRoute;
  signal?: AbortSignal;
}

export interface SelectMemoryResult {
  entries: MemorySearchResult[];
  method: "keyword" | "llm";
  formatted: string | undefined;
}

export async function selectRelevantMemories(
  input: SelectMemoryInput
): Promise<SelectMemoryResult> {
  const allEntries = listMemoryEntries({
    paths: input.paths,
    cwd: input.cwd,
    sessionId: input.sessionId,
    scopes: input.scopes
  });

  if (allEntries.length === 0) {
    return { entries: [], method: "keyword", formatted: undefined };
  }

  // If no selection model or few entries, use keyword search
  if (!input.selectionRoute || allEntries.length <= input.maxResults) {
    const results = searchMemory({
      paths: input.paths,
      cwd: input.cwd,
      sessionId: input.sessionId,
      scopes: input.scopes,
      maxResults: input.maxResults,
      query: input.prompt
    });
    const formatted = results.length > 0 ? formatMemorySearchResults(results) : undefined;
    return { entries: results, method: "keyword", formatted };
  }

  // Use LLM to select relevant memories
  try {
    const selected = await llmSelectMemories({
      entries: allEntries,
      prompt: input.prompt,
      maxResults: input.maxResults,
      route: input.selectionRoute,
      signal: input.signal
    });
    const formatted = selected.length > 0 ? formatMemorySearchResults(selected) : undefined;
    return { entries: selected, method: "llm", formatted };
  } catch {
    // Fallback to keyword search on LLM failure
    const results = searchMemory({
      paths: input.paths,
      cwd: input.cwd,
      sessionId: input.sessionId,
      scopes: input.scopes,
      maxResults: input.maxResults,
      query: input.prompt
    });
    const formatted = results.length > 0 ? formatMemorySearchResults(results) : undefined;
    return { entries: results, method: "keyword", formatted };
  }
}

async function llmSelectMemories(input: {
  entries: MemoryEntry[];
  prompt: string;
  maxResults: number;
  route: MemorySelectionRoute;
  signal?: AbortSignal;
}): Promise<MemorySearchResult[]> {
  const numbered = input.entries.map((entry, i) => `[${i}] (${entry.scope}) ${entry.text}`);
  const selectionPrompt = [
    `Given the user's current prompt, select up to ${input.maxResults} most relevant memory entries.`,
    `Return ONLY a JSON array of indices (e.g. [0, 3, 7]). No explanation.`,
    ``,
    `User prompt: ${input.prompt.slice(0, 2000)}`,
    ``,
    `Available memories:`,
    ...numbered
  ].join("\n");

  const request: ProviderRequest = {
    model: input.route.model,
    messages: [textMessage("user", selectionPrompt)],
    temperature: 0,
    maxOutputTokens: 256,
    signal: input.signal
  };

  const response = await input.route.adapter.complete(request);
  const indices = parseIndices(response.text, input.entries.length);

  return indices.slice(0, input.maxResults).map((index) => ({
    ...input.entries[index],
    score: input.maxResults - indices.indexOf(index) // Higher score for earlier picks
  }));
}

function parseIndices(text: string, maxIndex: number): number[] {
  // Extract JSON array from response
  const match = /\[[\d\s,]*\]/.exec(text);
  if (!match) {
    return [];
  }
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < maxIndex
    );
  } catch {
    return [];
  }
}
