import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "./fs-utils.js";

import { MemoryScope } from "./memory.js";
import { MemoryRootOptions } from "./memory-files.js";
import { MemorySearchHit, retrieveRelevantMemory } from "./memory-search.js";
import { MagiPaths } from "./paths.js";

export interface MemoryEvalCase {
  name?: string;
  query: string;
  expect?: string[];
  forbid?: string[];
  minResults?: number;
}

export interface MemoryEvalSuite {
  name?: string;
  maxResults?: number;
  minScore?: number;
  cases: MemoryEvalCase[];
}

export interface MemoryEvalCaseResult {
  name: string;
  query: string;
  passed: boolean;
  score: number;
  expectedMatched: string[];
  expectedMissing: string[];
  forbiddenClear: string[];
  forbiddenFound: string[];
  minResults?: number;
  resultCount: number;
  topResults: Array<{
    title: string;
    source: string;
    file: string;
    score: number;
    nodeId?: string;
  }>;
}

export interface MemoryEvalReport {
  version: 1;
  name: string;
  caseFile: string;
  generatedAt: string;
  total: number;
  passed: number;
  failed: number;
  score: number;
  minScore?: number;
  thresholdPassed: boolean;
  results: MemoryEvalCaseResult[];
}

export interface RunMemoryEvalInput extends MemoryRootOptions {
  paths: MagiPaths;
  cwd: string;
  caseFile: string;
  maxResults?: number;
  minScore?: number;
  sessionId?: string;
  scopes?: MemoryScope[];
}

export function runMemoryEval(input: RunMemoryEvalInput): MemoryEvalReport {
  const suite = readMemoryEvalSuite(input.caseFile);
  const maxResults = input.maxResults ?? suite.maxResults ?? 8;
  const minScore = input.minScore ?? suite.minScore;
  const results = suite.cases.map((item, index) => {
    const hits = retrieveRelevantMemory({
      appRoot: input.appRoot,
      root: input.root,
      query: item.query,
      maxResults,
      audit: false,
      sessionId: input.sessionId,
      legacy: {
        paths: input.paths,
        cwd: input.cwd,
        sessionId: input.sessionId,
        scopes: input.scopes
      }
    });
    return evaluateMemoryCase(item, hits, index);
  });
  const passed = results.filter((item) => item.passed).length;
  const score =
    results.length === 0 ? 0 : results.reduce((sum, item) => sum + item.score, 0) / results.length;
  const thresholdPassed = minScore === undefined || score >= minScore;
  return {
    version: 1,
    name: suite.name ?? "memory-recall",
    caseFile: input.caseFile,
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    score,
    minScore,
    thresholdPassed,
    results
  };
}

export function writeMemoryEvalReport(file: string, report: MemoryEvalReport): void {
  mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, `${JSON.stringify(report, null, 2)}\n`);
}

export function formatMemoryEvalReport(report: MemoryEvalReport): string {
  const lines = [
    `Memory recall eval: ${report.name}`,
    `cases: ${report.total}`,
    `passed: ${report.passed}`,
    `failed: ${report.failed}`,
    `score: ${report.score.toFixed(2)}`
  ];
  if (report.minScore !== undefined) {
    lines.push(`min score: ${report.minScore.toFixed(2)}`);
    lines.push(`threshold: ${report.thresholdPassed ? "PASS" : "FAIL"}`);
  }
  for (const [index, result] of report.results.entries()) {
    lines.push("");
    lines.push(`${index + 1}. ${result.passed ? "PASS" : "FAIL"} ${result.name}`);
    lines.push(`   query: ${result.query}`);
    lines.push(`   score: ${result.score.toFixed(2)}`);
    lines.push(`   results: ${result.resultCount}`);
    if (result.expectedMatched.length > 0) {
      lines.push(`   expected matched: ${result.expectedMatched.join(", ")}`);
    }
    if (result.expectedMissing.length > 0) {
      lines.push(`   expected missing: ${result.expectedMissing.join(", ")}`);
    }
    if (result.forbiddenFound.length > 0) {
      lines.push(`   forbidden found: ${result.forbiddenFound.join(", ")}`);
    }
    if (result.minResults !== undefined) {
      lines.push(`   min results: ${result.minResults}`);
    }
    for (const hit of result.topResults.slice(0, 3)) {
      lines.push(`   - ${hit.title} [${hit.source}] score=${hit.score.toFixed(2)} ${hit.file}`);
    }
  }
  return lines.join("\n");
}

function readMemoryEvalSuite(file: string): MemoryEvalSuite {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Invalid Memory eval case file: ${file}`);
  }
  const rawCases = parsed.cases;
  if (!Array.isArray(rawCases)) {
    throw new Error("Memory eval case file requires a cases array");
  }
  const cases = rawCases.map(readMemoryEvalCase);
  return {
    name: readOptionalString(parsed.name),
    maxResults: readOptionalPositiveInteger(parsed.maxResults),
    minScore: readOptionalScore(parsed.minScore),
    cases
  };
}

function readMemoryEvalCase(value: unknown, index: number): MemoryEvalCase {
  if (!isRecord(value)) {
    throw new Error(`Memory eval case ${index + 1} must be an object`);
  }
  const query = readRequiredString(value.query, `Memory eval case ${index + 1} query`);
  return {
    name: readOptionalString(value.name),
    query,
    expect: readStringList(value.expect, `Memory eval case ${index + 1} expect`),
    forbid: readStringList(value.forbid, `Memory eval case ${index + 1} forbid`),
    minResults: readOptionalPositiveInteger(value.minResults)
  };
}

function evaluateMemoryCase(
  item: MemoryEvalCase,
  hits: MemorySearchHit[],
  index: number
): MemoryEvalCaseResult {
  const haystacks = hits.map(memoryHitHaystack);
  const expected = item.expect ?? [];
  const forbidden = item.forbid ?? [];
  const expectedMatched = expected.filter((text) => containsText(haystacks, text));
  const expectedMissing = expected.filter((text) => !containsText(haystacks, text));
  const forbiddenFound = forbidden.filter((text) => containsText(haystacks, text));
  const forbiddenClear = forbidden.filter((text) => !containsText(haystacks, text));
  const minResultsPassed = item.minResults === undefined || hits.length >= item.minResults;
  const checkCount = expected.length + forbidden.length + (item.minResults === undefined ? 0 : 1);
  const passedChecks = expectedMatched.length + forbiddenClear.length;
  const minResultScore = item.minResults === undefined ? 0 : minResultsPassed ? 1 : 0;
  const score =
    checkCount === 0 ? (hits.length > 0 ? 1 : 0) : (passedChecks + minResultScore) / checkCount;
  const passed = expectedMissing.length === 0 && forbiddenFound.length === 0 && minResultsPassed;
  return {
    name: item.name ?? `case ${index + 1}`,
    query: item.query,
    passed,
    score,
    expectedMatched,
    expectedMissing,
    forbiddenClear,
    forbiddenFound,
    minResults: item.minResults,
    resultCount: hits.length,
    topResults: hits.slice(0, 5).map((hit) => ({
      title: hit.title,
      source: hit.source,
      file: hit.file,
      score: hit.score,
      nodeId: hit.nodeId
    }))
  };
}

function memoryHitHaystack(hit: MemorySearchHit): string {
  return normalizeEvalText(
    [
      hit.title,
      hit.file,
      hit.snippet,
      hit.source,
      hit.nodeId,
      hit.sourceId,
      hit.chunkId,
      hit.sourceKind
    ]
      .filter(Boolean)
      .join("\n")
  );
}

function containsText(haystacks: string[], text: string): boolean {
  const normalized = normalizeEvalText(text);
  return normalized.length > 0 && haystacks.some((item) => item.includes(normalized));
}

function normalizeEvalText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function readStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((item, index) => readRequiredString(item, `${label}[${index}]`));
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Memory eval numeric fields must be positive integers");
  }
  return value;
}

function readOptionalScore(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Memory eval minScore must be a number between 0 and 1");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
