import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { resolveWorkspacePath } from "./workspace.js";

export type LspAction =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol"
  | "goToImplementation"
  | "prepareCallHierarchy"
  | "incomingCalls"
  | "outgoingCalls";

export interface LspRequest {
  action: LspAction;
  filePath?: string;
  line?: number;
  character?: number;
  query?: string;
  maxResults?: number;
}

export interface LspLocation {
  filePath: string;
  line: number;
  character: number;
  endLine?: number;
  endCharacter?: number;
  text?: string;
}

export interface LspSymbol {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  detail?: string;
}

export interface LspCallHierarchyItem {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  containerName?: string;
}

export interface LspIncomingCall {
  from: LspCallHierarchyItem;
  fromSpans: LspLocation[];
}

export interface LspOutgoingCall {
  to: LspCallHierarchyItem;
  fromSpans: LspLocation[];
}

export const LSP_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "goToDefinition",
        "findReferences",
        "hover",
        "documentSymbol",
        "workspaceSymbol",
        "goToImplementation",
        "prepareCallHierarchy",
        "incomingCalls",
        "outgoingCalls"
      ]
    },
    filePath: { type: "string" },
    file_path: { type: "string" },
    line: { type: "number" },
    character: { type: "number" },
    query: { type: "string" },
    maxResults: { type: "number" },
    max_results: { type: "number" }
  },
  required: ["action"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseLspRequest(input: Record<string, unknown>): LspRequest {
  const action = readAction(input.action);
  return {
    action,
    filePath: readOptionalString(input.filePath ?? input.file_path, "filePath"),
    line: readOptionalPositiveInteger(input.line, "line"),
    character: readOptionalPositiveInteger(input.character, "character"),
    query: readOptionalString(input.query, "query"),
    maxResults: readOptionalPositiveInteger(input.maxResults ?? input.max_results, "maxResults")
  };
}

export function executeLspRequest(input: { cwd: string; request: LspRequest }): string {
  const workspace = createTsWorkspace(input.cwd);
  switch (input.request.action) {
    case "goToDefinition":
      return formatLocations("Definitions", goToDefinition(workspace, input.request));
    case "findReferences":
      return formatLocations("References", findReferences(workspace, input.request));
    case "hover":
      return hover(workspace, input.request);
    case "documentSymbol":
      return formatSymbols("Document symbols", documentSymbols(workspace, input.request));
    case "workspaceSymbol":
      return formatSymbols("Workspace symbols", workspaceSymbols(workspace, input.request));
    case "goToImplementation":
      return formatLocations("Implementations", goToImplementation(workspace, input.request));
    case "prepareCallHierarchy":
      return formatCallHierarchyItems(
        "Call hierarchy items",
        prepareCallHierarchy(workspace, input.request)
      );
    case "incomingCalls":
      return formatIncomingCalls(incomingCalls(workspace, input.request));
    case "outgoingCalls":
      return formatOutgoingCalls(outgoingCalls(workspace, input.request));
  }
}

export function goToDefinition(workspace: TsWorkspace, request: LspRequest): LspLocation[] {
  const position = requirePosition(workspace, request);
  const definitions =
    workspace.languageService.getDefinitionAtPosition(position.fileName, position.offset) ?? [];
  return definitions.map((definition) =>
    locationFromTextSpan(workspace, definition.fileName, definition.textSpan)
  );
}

export function findReferences(workspace: TsWorkspace, request: LspRequest): LspLocation[] {
  const position = requirePosition(workspace, request);
  const references =
    workspace.languageService.findReferences(position.fileName, position.offset) ?? [];
  return references.flatMap((symbol) =>
    symbol.references.map((reference) =>
      locationFromTextSpan(workspace, reference.fileName, reference.textSpan)
    )
  );
}

export function goToImplementation(workspace: TsWorkspace, request: LspRequest): LspLocation[] {
  const position = requirePosition(workspace, request);
  const implementations =
    workspace.languageService.getImplementationAtPosition(position.fileName, position.offset) ?? [];
  return implementations.map((implementation) =>
    locationFromTextSpan(workspace, implementation.fileName, implementation.textSpan)
  );
}

export function hover(workspace: TsWorkspace, request: LspRequest): string {
  const position = requirePosition(workspace, request);
  const info = workspace.languageService.getQuickInfoAtPosition(position.fileName, position.offset);
  if (!info) {
    return "No hover information";
  }
  return (
    [
      ts.displayPartsToString(info.displayParts ?? []),
      ts.displayPartsToString(info.documentation ?? []),
      ...(info.tags ?? []).map((tag) =>
        `@${tag.name} ${ts.displayPartsToString(tag.text ?? [])}`.trim()
      )
    ]
      .filter((line) => line.trim())
      .join("\n") || "No hover information"
  );
}

export function documentSymbols(workspace: TsWorkspace, request: LspRequest): LspSymbol[] {
  const fileName = requireFile(workspace, request.filePath);
  const items = workspace.languageService.getNavigationTree(fileName);
  if (!items) {
    return [];
  }
  return flattenNavigationItems(workspace, fileName, items.childItems ?? []);
}

export function workspaceSymbols(workspace: TsWorkspace, request: LspRequest): LspSymbol[] {
  const query = request.query?.toLowerCase() ?? "";
  const maxResults = request.maxResults ?? 100;
  const symbols = workspace.fileNames.flatMap((fileName) => {
    const tree = workspace.languageService.getNavigationTree(fileName);
    return tree ? flattenNavigationItems(workspace, fileName, tree.childItems ?? []) : [];
  });
  return symbols
    .filter((symbol) => !query || symbol.name.toLowerCase().includes(query))
    .sort(
      (left, right) =>
        left.filePath.localeCompare(right.filePath) ||
        left.line - right.line ||
        left.name.localeCompare(right.name)
    )
    .slice(0, maxResults);
}

export function prepareCallHierarchy(
  workspace: TsWorkspace,
  request: LspRequest
): LspCallHierarchyItem[] {
  const position = requirePosition(workspace, request);
  const prepared = workspace.languageService.prepareCallHierarchy(
    position.fileName,
    position.offset
  );
  if (!prepared) {
    return [];
  }
  const items = Array.isArray(prepared) ? prepared : [prepared];
  return items.map((item) => callHierarchyItemFromTs(workspace, item));
}

export function incomingCalls(workspace: TsWorkspace, request: LspRequest): LspIncomingCall[] {
  const position = requirePosition(workspace, request);
  return workspace.languageService
    .provideCallHierarchyIncomingCalls(position.fileName, position.offset)
    .map((call) => ({
      from: callHierarchyItemFromTs(workspace, call.from),
      fromSpans: call.fromSpans.map((span) => locationFromTextSpan(workspace, call.from.file, span))
    }));
}

export function outgoingCalls(workspace: TsWorkspace, request: LspRequest): LspOutgoingCall[] {
  const position = requirePosition(workspace, request);
  return workspace.languageService
    .provideCallHierarchyOutgoingCalls(position.fileName, position.offset)
    .map((call) => ({
      to: callHierarchyItemFromTs(workspace, call.to),
      fromSpans: call.fromSpans.map((span) =>
        locationFromTextSpan(workspace, position.fileName, span)
      )
    }));
}

export interface TsWorkspace {
  cwd: string;
  fileNames: string[];
  languageService: ts.LanguageService;
}

export function createTsWorkspace(cwd: string): TsWorkspace {
  // Realpath the cwd so all path comparisons (including relative path
  // formatting in result output) are consistent with resolveWorkspacePath.
  let realCwd = cwd;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    // fall back
  }
  const fileNames = collectSourceFiles(realCwd);
  const versions = new Map(
    fileNames.map((fileName) => [fileName, statSync(fileName).mtimeMs.toString()])
  );
  const compilerOptions = readCompilerOptions(realCwd);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => fileNames,
    getScriptVersion: (fileName) => versions.get(path.resolve(fileName)) ?? "0",
    getScriptSnapshot: (fileName) => {
      if (!existsSync(fileName)) {
        return undefined;
      }
      return ts.ScriptSnapshot.fromString(readFileSync(fileName, "utf8"));
    },
    getCurrentDirectory: () => realCwd,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories
  };
  return {
    cwd: realCwd,
    fileNames,
    languageService: ts.createLanguageService(host, ts.createDocumentRegistry())
  };
}

function collectSourceFiles(cwd: string): string[] {
  const files: string[] = [];
  // Use realpath so paths match what resolveWorkspacePath returns
  let rootDir = cwd;
  try {
    rootDir = realpathSync(cwd);
  } catch {
    // fall back to cwd
  }
  walk(rootDir);
  return files.sort();

  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".git" || name === ".magi-next") {
        continue;
      }
      const absolutePath = path.join(dir, name);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (stat.isFile() && /\.(c|m)?(t|j)sx?$/.test(name)) {
        files.push(absolutePath);
      }
    }
  }
}

function readCompilerOptions(cwd: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    return defaultCompilerOptions();
  }
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    return defaultCompilerOptions();
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
  return {
    ...defaultCompilerOptions(),
    ...parsed.options
  };
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: false,
    skipLibCheck: true
  };
}

function requirePosition(
  workspace: TsWorkspace,
  request: LspRequest
): { fileName: string; offset: number } {
  const fileName = requireFile(workspace, request.filePath);
  if (request.line === undefined || request.character === undefined) {
    throw new Error("LSP action requires filePath, line, and character");
  }
  const sourceFile = workspace.languageService.getProgram()?.getSourceFile(fileName);
  if (!sourceFile) {
    throw new Error(`LSP file is not loaded: ${request.filePath}`);
  }
  const offset = ts.getPositionOfLineAndCharacter(
    sourceFile,
    request.line - 1,
    request.character - 1
  );
  return { fileName, offset };
}

function requireFile(workspace: TsWorkspace, filePath: string | undefined): string {
  if (!filePath) {
    throw new Error("LSP action requires filePath");
  }
  const resolved = resolveWorkspacePath(workspace.cwd, filePath).absolutePath;
  if (!workspace.fileNames.includes(resolved)) {
    throw new Error(`LSP file is not a TypeScript or JavaScript source file: ${filePath}`);
  }
  return resolved;
}

function locationFromTextSpan(
  workspace: TsWorkspace,
  fileName: string,
  textSpan: ts.TextSpan
): LspLocation {
  const sourceFile = workspace.languageService.getProgram()?.getSourceFile(fileName);
  if (!sourceFile) {
    throw new Error(`LSP source file is not loaded: ${fileName}`);
  }
  const start = sourceFile.getLineAndCharacterOfPosition(textSpan.start);
  const end = sourceFile.getLineAndCharacterOfPosition(textSpan.start + textSpan.length);
  const startOfLine = sourceFile.getPositionOfLineAndCharacter(start.line, 0);
  const endOfLine = sourceFile.text.indexOf("\n", startOfLine);
  const lineText = sourceFile.text
    .slice(startOfLine, endOfLine === -1 ? sourceFile.text.length : endOfLine)
    .trim();
  return {
    filePath: path.relative(workspace.cwd, fileName),
    line: start.line + 1,
    character: start.character + 1,
    endLine: end.line + 1,
    endCharacter: end.character + 1,
    text: lineText
  };
}

function flattenNavigationItems(
  workspace: TsWorkspace,
  fileName: string,
  items: ts.NavigationTree[]
): LspSymbol[] {
  return items.flatMap((item) => {
    const spans = item.spans.length > 0 ? item.spans : [];
    const own = spans.map((span): LspSymbol => {
      const location = locationFromTextSpan(workspace, fileName, span);
      return {
        name: item.text,
        kind: item.kind,
        filePath: location.filePath,
        line: location.line,
        character: location.character,
        endLine: location.endLine ?? location.line,
        endCharacter: location.endCharacter ?? location.character,
        detail: item.kindModifiers || undefined
      };
    });
    return [...own, ...flattenNavigationItems(workspace, fileName, item.childItems ?? [])];
  });
}

function callHierarchyItemFromTs(
  workspace: TsWorkspace,
  item: ts.CallHierarchyItem
): LspCallHierarchyItem {
  const location = locationFromTextSpan(workspace, item.file, item.selectionSpan);
  const whole = locationFromTextSpan(workspace, item.file, item.span);
  return {
    name: item.name,
    kind: item.kind,
    filePath: location.filePath,
    line: location.line,
    character: location.character,
    endLine: whole.endLine ?? location.line,
    endCharacter: whole.endCharacter ?? location.character,
    containerName: item.containerName
  };
}

function formatLocations(title: string, locations: LspLocation[]): string {
  if (locations.length === 0) {
    return `${title}: no results`;
  }
  return [
    `${title}: ${locations.length} result${locations.length === 1 ? "" : "s"}`,
    ...locations.map((location) =>
      [
        `${location.filePath}:${location.line}:${location.character}`,
        location.text ? `  ${location.text}` : undefined
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    )
  ].join("\n");
}

function formatSymbols(title: string, symbols: LspSymbol[]): string {
  if (symbols.length === 0) {
    return `${title}: no results`;
  }
  return [
    `${title}: ${symbols.length} result${symbols.length === 1 ? "" : "s"}`,
    ...symbols.map(
      (symbol) =>
        `${symbol.filePath}:${symbol.line}:${symbol.character} ${symbol.kind} ${symbol.name}`
    )
  ].join("\n");
}

function formatCallHierarchyItems(title: string, items: LspCallHierarchyItem[]): string {
  if (items.length === 0) {
    return `${title}: no results`;
  }
  return [
    `${title}: ${items.length} result${items.length === 1 ? "" : "s"}`,
    ...items.map(formatCallHierarchyItem)
  ].join("\n");
}

function formatIncomingCalls(calls: LspIncomingCall[]): string {
  if (calls.length === 0) {
    return "Incoming calls: no results";
  }
  return [
    `Incoming calls: ${calls.length} result${calls.length === 1 ? "" : "s"}`,
    ...calls.map((call) =>
      [
        `from ${formatCallHierarchyItem(call.from)}`,
        ...call.fromSpans.map((span) => `  at ${formatLocationLine(span)}`)
      ].join("\n")
    )
  ].join("\n");
}

function formatOutgoingCalls(calls: LspOutgoingCall[]): string {
  if (calls.length === 0) {
    return "Outgoing calls: no results";
  }
  return [
    `Outgoing calls: ${calls.length} result${calls.length === 1 ? "" : "s"}`,
    ...calls.map((call) =>
      [
        `to ${formatCallHierarchyItem(call.to)}`,
        ...call.fromSpans.map((span) => `  from ${formatLocationLine(span)}`)
      ].join("\n")
    )
  ].join("\n");
}

function formatCallHierarchyItem(item: LspCallHierarchyItem): string {
  const container = item.containerName ? ` (${item.containerName})` : "";
  return `${item.filePath}:${item.line}:${item.character} ${item.kind} ${item.name}${container}`;
}

function formatLocationLine(location: LspLocation): string {
  return `${location.filePath}:${location.line}:${location.character}${location.text ? ` ${location.text}` : ""}`;
}

function readAction(value: unknown): LspAction {
  if (
    value === "goToDefinition" ||
    value === "findReferences" ||
    value === "hover" ||
    value === "documentSymbol" ||
    value === "workspaceSymbol" ||
    value === "goToImplementation" ||
    value === "prepareCallHierarchy" ||
    value === "incomingCalls" ||
    value === "outgoingCalls"
  ) {
    return value;
  }
  throw new Error("LSP action must be a supported action name");
}

function readOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`LSP ${name} must be a non-empty string`);
  }
  return value;
}

function readOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`LSP ${name} must be a positive integer`);
  }
  return value;
}
