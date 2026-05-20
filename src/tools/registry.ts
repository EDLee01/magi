import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { MagiMessage, MagiToolDefinition, MagiToolUsePart } from "../providers/ir.js";
import { executeConfigTool, ConfigToolInputSchema, parseConfigToolInput } from "./config-tool.js";
import {
  addCronJob,
  applyCronUpdate,
  CRON_CREATE_SCHEMA,
  CRON_DELETE_SCHEMA,
  CRON_LIST_SCHEMA,
  CRON_UPDATE_SCHEMA,
  cronStorePathFromRoot,
  deleteCronJob,
  formatCronJob,
  formatCronList,
  listCronJobs
} from "./cron.js";
import { createUnifiedDiff, editWorkspaceFile, readWorkspaceFile, writeWorkspaceFile } from "./files.js";
import {
  checkoutGitBranch,
  createGitBranch,
  getGitDiff,
  getGitLog,
  getGitShow,
  getGitStatus,
  getGitSummary,
  listGitBranches,
  stageGitPaths
} from "./git.js";
import { executeLspRequest, LSP_SCHEMA, parseLspRequest } from "./lsp.js";
import { formatSearchMatches, globWorkspace, searchWorkspace } from "./search.js";
import { runShellCommand } from "./shell.js";
import { formatMonitorResult, getMonitorData, MonitorInputSchema, parseMonitorInput } from "./monitor.js";
import { executeSleep, parseSleepInput, SleepInputSchema } from "./sleep.js";
import { executeFileCopy, formatFileCopyResult, FileCopyInputSchema, parseFileCopyInput } from "./file-copy.js";
import { executeFileMove, formatFileMoveResult, FileMoveInputSchema, parseFileMoveInput } from "./file-move.js";
import { executeFileDelete, FileDeleteInputSchema, formatFileDeleteResult, parseFileDeleteInput } from "./file-delete.js";
import { DirCreateInputSchema, executeDirCreate, formatDirCreateResult, parseDirCreateInput } from "./dir-create.js";
import { DirListInputSchema, executeDirList, formatDirListResult, parseDirListInput } from "./dir-list.js";
import { executeProcessList, formatProcessListResult, parseProcessListInput, ProcessListInputSchema } from "./process-list.js";
import { executeKillProcess, formatKillProcessResult, KillProcessInputSchema, parseKillProcessInput } from "./kill-process.js";
import { EnvironmentInputSchema, executeEnvironment, formatEnvironmentResult, parseEnvironmentInput } from "./environment.js";
import { DiskUsageInputSchema, executeDiskUsage, formatDiskUsageResult, parseDiskUsageInput } from "./disk-usage.js";
import { executeSystemInfo, formatSystemInfoResult, parseSystemInfoInput, SystemInfoInputSchema } from "./system-info.js";
import { executeHttpRequest, formatHttpRequestResult, HttpRequestInputSchema, parseHttpRequestInput } from "./http-request.js";
import { DownloadFileInputSchema, executeDownloadFile, formatDownloadFileResult, parseDownloadFileInput } from "./download-file.js";
import { executeJsonQuery, formatJsonQueryResult, JsonQueryInputSchema, parseJsonQueryInput } from "./json-query.js";
import { ArchiveCreateInputSchema, executeArchiveCreate, formatArchiveCreateResult, parseArchiveCreateInput } from "./archive-create.js";
import { ArchiveExtractInputSchema, executeArchiveExtract, formatArchiveExtractResult, parseArchiveExtractInput } from "./archive-extract.js";
import { executeGitBranchDelete, formatGitBranchDeleteResult, GitBranchDeleteInputSchema, parseGitBranchDeleteInput } from "./git-branch-delete.js";
import { executeGitStash, formatGitStashResult, GitStashInputSchema, parseGitStashInput } from "./git-stash.js";
import { executeGitReset, formatGitResetResult, GitResetInputSchema, parseGitResetInput } from "./git-reset.js";
import { executeFileFind, FileFindInputSchema, formatFileFindResult, parseFileFindInput } from "./file-find.js";
import { executeHeadTail, formatHeadTailResult, HeadTailInputSchema, parseHeadTailInput } from "./head-tail.js";
import { executeTextStats, formatTextStatsResult, parseTextStatsInput, TextStatsInputSchema } from "./text-stats.js";
import { executeTreeView, formatTreeViewResult, parseTreeViewInput, TreeViewInputSchema } from "./tree-view.js";
import { executeWhoAmI, formatWhoAmIResult, parseWhoAmIInput, WhoAmIInputSchema } from "./whoami.js";
import { executeNetworkCheck, formatNetworkCheckResult, NetworkCheckInputSchema, parseNetworkCheckInput } from "./network-check.js";
import { Base64InputSchema, executeBase64, formatBase64Result, parseBase64Input } from "./base64.js";
import { executeWhich, formatWhichResult, parseWhichInput, WhichInputSchema } from "./which.js";
import { DateInputSchema, executeDate, formatDateResult, parseDateInput } from "./date.js";
import { sshExec } from "../ssh/exec.js";
import { sshFileRead, sshFileWrite } from "../ssh/file.js";
import { executeSnip, formatSnipResult, parseSnipInput, SnipInputSchema } from "./snip.js";
import { executeSkillTool, parseSkillToolInput, SkillToolInputSchema } from "./skill-tool.js";
import { writeMemdirEntry, MemdirType } from "../memdir.js";
import { formatTodoWriteResult, parseTodoWriteInput, replaceTodoList, TodoWriteInputSchema } from "./todo.js";
import { executeToolSearch, parseToolSearchInput, ToolSearchInputSchema } from "./tool-search.js";
import {
  executeTaskCreate,
  executeTaskGet,
  executeTaskList,
  executeTaskOutput,
  executeTaskStop,
  executeTaskUpdate,
  formatTaskCreateResult,
  formatTaskGetResult,
  formatTaskListResult,
  formatTaskOutputResult,
  formatTaskStopResult,
  formatTaskUpdateResult,
  parseTaskCreateInput,
  parseTaskUpdateInput,
  TaskCreateInputSchema,
  TaskGetInputSchema,
  TaskListInputSchema,
  TaskOutputInputSchema,
  TaskStopInputSchema,
  TaskUpdateInputSchema
} from "./tasks.js";
import {
  EnterPlanModeInputSchema,
  ExitPlanModeInputSchema,
  formatEnterPlanModeResult,
  formatExitPlanModeResult,
  parseEnterPlanModeInput,
  parseExitPlanModeInput
} from "./plan-mode.js";
import {
  EnterWorktreeInputSchema,
  ExitWorktreeInputSchema,
  executeEnterWorktree,
  executeExitWorktree,
  formatEnterWorktreeResult,
  formatExitWorktreeResult,
  parseEnterWorktreeInput,
  parseExitWorktreeInput,
  WorktreeState
} from "./worktree.js";
import {
  ghIssueView,
  ghPRDiff,
  ghPRList,
  ghPRView,
  GitHubIssueViewInputSchema,
  GitHubPRDiffInputSchema,
  GitHubPRListInputSchema,
  GitHubPRViewInputSchema
} from "./github.js";
import {
  AgentToolInputSchema,
  formatAgentToolResult,
  parseAgentToolInput
} from "./agent-tool.js";
import {
  executeNotebookEdit,
  executeNotebookRead,
  NotebookEditInputSchema,
  NotebookReadInputSchema,
  parseNotebookEditInput,
  parseNotebookReadInput
} from "./notebook.js";
import {
  defaultUserMessageSink,
  formatSendUserMessageResult,
  parseSendUserMessageInput,
  SEND_USER_MESSAGE_SCHEMA,
  UserMessageSink
} from "./user-message.js";
import {
  ASK_USER_QUESTION_SCHEMA,
  formatAskUserQuestionAnswer,
  normalizeAskUserQuestionAnswer,
  parseAskUserQuestionInput,
  UserQuestionResolver
} from "./user-question.js";
import { readWebFetchAllowlist, webFetch, webFetchHostAllowed } from "./web-fetch.js";
import {
  executeWebBrowser,
  formatWebBrowserResult,
  parseWebBrowserInput,
  WebBrowserInputSchema
} from "./web-browser.js";
import {
  formatWebSearchResult,
  parseWebSearchInput,
  webSearch,
  WebSearchInputSchema
} from "./web-search.js";
import {
  formatWorkspaceDiagnostics,
  parseWorkspaceDiagnosticsInput,
  runWorkspaceDiagnostics,
  WorkspaceDiagnosticsInputSchema
} from "./workspace-diagnostics.js";
import { resolveWorkspacePath } from "./workspace.js";
import { WebSearchConfig } from "../config.js";

export type ToolPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";
export type ToolPermissionDecision = "allow" | "ask" | "deny";

export interface ToolPermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface ToolPermissionResult {
  decision: ToolPermissionDecision;
  reason: string;
  diff?: string;
}

export interface RegisteredTool {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  inputSchema: Record<string, unknown>;
  call(input: Record<string, unknown>, context: ToolExecutionContext): Promise<string> | string;
  isReadOnly(input: Record<string, unknown>): boolean;
  isDestructive(input: Record<string, unknown>): boolean;
  isConcurrencySafe(input: Record<string, unknown>): boolean;
  checkPermissions?(input: Record<string, unknown>, context: ToolExecutionContext): ToolPermissionResult | undefined;
}

export interface SubAgentRequest {
  prompt: string;
  description: string;
  subagentType: string;
  runInBackground: boolean;
  /** Optional peer name or URL to dispatch the sub-agent to. */
  target?: string;
}

export interface SubAgentResult {
  agentId: string;
  status: "completed" | "running" | "failed";
  result?: string;
  error?: string;
}

export interface ToolExecutionContext {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  permissionMode: ToolPermissionMode;
  rules?: ToolPermissionRules;
  outputRoot?: string;
  stateRoot?: string;
  sessionId?: string;
  webSearchConfig?: WebSearchConfig;
  promptModel?: (request: { messages: MagiMessage[] }) => Promise<{ text: string }>;
  userQuestionResolver?: UserQuestionResolver;
  userMessageSink?: UserMessageSink;
  toolUse?: MagiToolUsePart;
  spawnSubAgent?: (request: SubAgentRequest) => Promise<SubAgentResult>;
}

export interface RegisteredToolResult {
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
  permission?: ToolPermissionResult;
}

export function getBuiltinToolRegistry(): Map<string, RegisteredTool> {
  return new Map(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
}

export function getBuiltinToolDefinitions(): MagiToolDefinition[] {
  return BUILTIN_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
}

export async function executeRegisteredTool(input: {
  cwd: string;
  toolUse: MagiToolUsePart;
  env?: NodeJS.ProcessEnv;
  permissionMode?: ToolPermissionMode;
  rules?: ToolPermissionRules;
  outputRoot?: string;
  stateRoot?: string;
  sessionId?: string;
  webSearchConfig?: WebSearchConfig;
  promptModel?: (request: { messages: MagiMessage[] }) => Promise<{ text: string }>;
  userQuestionResolver?: UserQuestionResolver;
  userMessageSink?: UserMessageSink;
  spawnSubAgent?: (request: SubAgentRequest) => Promise<SubAgentResult>;
  approvalResolver?: (request: { toolUse: MagiToolUsePart; permission: ToolPermissionResult }) => Promise<boolean> | boolean;
}): Promise<RegisteredToolResult> {
  const registry = getBuiltinToolRegistry();
  const tool = registry.get(input.toolUse.name);
  if (!tool) {
    return errorResult(input.toolUse, `Unknown tool: ${input.toolUse.name}`);
  }
  try {
    const context: ToolExecutionContext = {
      cwd: input.cwd,
      env: input.env,
      permissionMode: input.permissionMode ?? "default",
      rules: input.rules,
      outputRoot: input.outputRoot,
      stateRoot: input.stateRoot,
      sessionId: input.sessionId,
      webSearchConfig: input.webSearchConfig,
      promptModel: input.promptModel,
      userQuestionResolver: input.userQuestionResolver,
      userMessageSink: input.userMessageSink,
      toolUse: input.toolUse,
      spawnSubAgent: input.spawnSubAgent
    };
    const permission = checkToolPermission({
      toolUse: input.toolUse,
      mode: context.permissionMode,
      rules: context.rules,
      tool,
      env: context.env
    });
    // Generate diff preview for FileWrite/FileEdit when approval is needed
    if (permission.decision === "ask" && (input.toolUse.name === "FileWrite" || input.toolUse.name === "FileEdit")) {
      try {
        const filePath = readString(input.toolUse.input, "file_path");
        const resolved = resolveWorkspacePath(input.cwd, filePath);
        const before = existsSync(resolved.absolutePath) ? readFileSync(resolved.absolutePath, "utf8") : "";
        let after: string;
        if (input.toolUse.name === "FileWrite") {
          after = readString(input.toolUse.input, "content");
        } else {
          const oldString = readString(input.toolUse.input, "old_string");
          const newString = readString(input.toolUse.input, "new_string");
          const replaceAll = Boolean(input.toolUse.input.replace_all);
          after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
        }
        permission.diff = createUnifiedDiff(resolved.relativePath, before, after);
      } catch {
        // Diff preview is best-effort
      }
    }
    const approvalPermission = permission.decision === "ask" ? permission : undefined;
    if (permission.decision === "ask") {
      const approved = await input.approvalResolver?.({ toolUse: input.toolUse, permission });
      if (!approved) {
        return errorResult(input.toolUse, `Permission ask: ${permission.reason}`, permission);
      }
    } else if (permission.decision !== "allow") {
      return errorResult(input.toolUse, `Permission ${permission.decision}: ${permission.reason}`);
    }
    const raw = await tool.call(input.toolUse.input, context);
    return {
      toolCallId: input.toolUse.id,
      toolName: input.toolUse.name,
      content: formatToolResult({
        content: raw,
        outputRoot: context.outputRoot,
        maxChars: 30_000,
        previewChars: 2_000
      }),
      permission: approvalPermission
    };
  } catch (error) {
    return errorResult(input.toolUse, error instanceof Error ? error.message : String(error));
  }
}

export async function executeRegisteredTools(input: {
  cwd: string;
  toolUses: MagiToolUsePart[];
  env?: NodeJS.ProcessEnv;
  permissionMode?: ToolPermissionMode;
  rules?: ToolPermissionRules;
  outputRoot?: string;
  stateRoot?: string;
  sessionId?: string;
  webSearchConfig?: WebSearchConfig;
  promptModel?: (request: { messages: MagiMessage[] }) => Promise<{ text: string }>;
  userQuestionResolver?: UserQuestionResolver;
  userMessageSink?: UserMessageSink;
  spawnSubAgent?: (request: SubAgentRequest) => Promise<SubAgentResult>;
  approvalResolver?: (request: { toolUse: MagiToolUsePart; permission: ToolPermissionResult }) => Promise<boolean> | boolean;
}): Promise<RegisteredToolResult[]> {
  const registry = getBuiltinToolRegistry();
  const results = new Array<RegisteredToolResult>(input.toolUses.length);
  const concurrent: Array<{ index: number; toolUse: MagiToolUsePart }> = [];
  const sequential: Array<{ index: number; toolUse: MagiToolUsePart }> = [];

  input.toolUses.forEach((toolUse, index) => {
    const tool = registry.get(toolUse.name);
    if (tool?.isConcurrencySafe(toolUse.input)) {
      concurrent.push({ index, toolUse });
    } else {
      sequential.push({ index, toolUse });
    }
  });

  await Promise.all(concurrent.map(async ({ index, toolUse }) => {
    results[index] = await executeRegisteredTool({ ...input, toolUse });
  }));
  for (const { index, toolUse } of sequential) {
    results[index] = await executeRegisteredTool({ ...input, toolUse });
  }
  return results;
}

export function checkToolPermission(input: {
  toolUse: MagiToolUsePart;
  mode: ToolPermissionMode;
  rules?: ToolPermissionRules;
  env?: NodeJS.ProcessEnv;
  tool?: RegisteredTool;
}): ToolPermissionResult {
  const tool = input.tool ?? getBuiltinToolRegistry().get(input.toolUse.name);
  if (!tool) {
    return { decision: "deny", reason: `Unknown tool: ${input.toolUse.name}` };
  }
  const context: ToolExecutionContext = {
    cwd: ".",
    permissionMode: input.mode,
    rules: input.rules,
    env: input.env
  };
  const custom = tool.checkPermissions?.(input.toolUse.input, context);
  if (custom) {
    return custom;
  }
  const ruleDecision = matchRules(input.toolUse, input.rules);
  if (ruleDecision) {
    return ruleDecision;
  }
  if (input.mode === "bypassPermissions" || input.mode === "acceptEdits") {
    return { decision: "allow", reason: `${input.mode} mode` };
  }
  if (input.mode === "plan" && !tool.isReadOnly(input.toolUse.input)) {
    return { decision: "deny", reason: `${input.toolUse.name} is not allowed in plan mode` };
  }
  if (input.mode === "default" && !tool.isReadOnly(input.toolUse.input)) {
    return { decision: "ask", reason: `${input.toolUse.name} requires approval` };
  }
  return { decision: "allow", reason: "read-only tool" };
}

export function formatToolResult(input: {
  content: string;
  outputRoot?: string;
  maxChars?: number;
  previewChars?: number;
}): string {
  const maxChars = input.maxChars ?? 30_000;
  if (input.content.length <= maxChars) {
    return input.content;
  }
  if (!input.outputRoot) {
    return `${input.content.slice(0, input.previewChars ?? 2_000)}\n...[truncated]...`;
  }
  mkdirSync(input.outputRoot, { recursive: true });
  const file = path.join(input.outputRoot, `${randomUUID()}.txt`);
  writeFileSync(file, input.content, "utf8");
  return `${input.content.slice(0, input.previewChars ?? 2_000)}\n...[truncated]...\n\nFull output saved to: ${file}`;
}

const BUILTIN_TOOLS: RegisteredTool[] = [
  {
    name: "FileRead",
    description: "Read a UTF-8 text file inside the current workspace.",
    category: "files",
    tags: ["file", "read", "workspace"],
    inputSchema: objectSchema({
      file_path: { type: "string" },
      max_bytes: { type: "number" }
    }, ["file_path"]),
    call: (input, context) => {
      const result = readWorkspaceFile({
        cwd: context.cwd,
        filePath: readString(input, "file_path"),
        maxBytes: readOptionalNumber(input, "max_bytes")
      });
      return `Read ${result.path} (${result.sizeBytes} bytes)\n${result.content}`;
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "FileWrite",
    description: "Create or overwrite a UTF-8 text file inside the current workspace.",
    category: "files",
    tags: ["file", "write", "workspace"],
    inputSchema: objectSchema({
      file_path: { type: "string" },
      content: { type: "string" }
    }, ["file_path", "content"]),
    call: (input, context) => {
      const result = writeWorkspaceFile({
        cwd: context.cwd,
        filePath: readString(input, "file_path"),
        content: readString(input, "content"),
        approved: true
      });
      return `Wrote ${result.path}\n${result.diff}`;
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "FileEdit",
    description: "Replace text in a UTF-8 file inside the current workspace.",
    category: "files",
    tags: ["file", "edit", "workspace"],
    inputSchema: objectSchema({
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" }
    }, ["file_path", "old_string", "new_string"]),
    call: (input, context) => {
      const result = editWorkspaceFile({
        cwd: context.cwd,
        filePath: readString(input, "file_path"),
        oldString: readString(input, "old_string"),
        newString: readString(input, "new_string"),
        replaceAll: readOptionalBoolean(input, "replace_all"),
        approved: true
      });
      return `Wrote ${result.path}\n${result.diff}`;
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "NotebookEdit",
    description: "Edit a Jupyter notebook (.ipynb) cell: replace, insert, or delete.",
    category: "files",
    tags: ["notebook", "jupyter", "ipynb", "edit"],
    inputSchema: NotebookEditInputSchema,
    call: (input, context) => {
      const parsed = parseNotebookEditInput(input);
      return executeNotebookEdit(context.cwd, parsed);
    },
    isReadOnly: () => false,
    isDestructive: (input) => input.edit_mode === "delete",
    isConcurrencySafe: () => false
  },
  {
    name: "NotebookRead",
    description: "Read a Jupyter notebook (.ipynb) and display cell contents.",
    category: "files",
    tags: ["notebook", "jupyter", "ipynb", "read"],
    inputSchema: NotebookReadInputSchema,
    call: (input, context) => {
      const parsed = parseNotebookReadInput(input);
      return executeNotebookRead(context.cwd, parsed);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "Glob",
    description: "Find files by glob pattern inside the current workspace.",
    category: "search",
    tags: ["glob", "file", "workspace"],
    inputSchema: objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
      max_matches: { type: "number" }
    }, ["pattern"]),
    call: (input, context) => {
      const matches = globWorkspace({
        cwd: context.cwd,
        pattern: readString(input, "pattern"),
        basePath: readOptionalString(input, "path"),
        maxMatches: readOptionalNumber(input, "max_matches")
      });
      return matches.length === 0 ? "No matches" : matches.join("\n");
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "Grep",
    description: "Search text in the current workspace with ripgrep-compatible options.",
    category: "search",
    tags: ["grep", "search", "ripgrep", "workspace"],
    inputSchema: objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      type: { type: "string" },
      output_mode: { type: "string" },
      max_matches: { type: "number" },
      head_limit: { type: "number" },
      ignore_case: { type: "boolean" },
      fixed_strings: { type: "boolean" },
      line_numbers: { type: "boolean" },
      before_context: { type: "number" },
      after_context: { type: "number" },
      context: { type: "number" }
    }, ["pattern"]),
    call: (input, context) => {
      const outputMode = readOutputMode(input, "output_mode");
      const contextLines = readOptionalNumber(input, "context");
      const matches = searchWorkspace({
        cwd: context.cwd,
        query: readString(input, "pattern"),
        basePath: readOptionalString(input, "path"),
        glob: readOptionalString(input, "glob"),
        type: readOptionalString(input, "type"),
        maxMatches: readOptionalNumber(input, "max_matches"),
        headLimit: readOptionalNumber(input, "head_limit"),
        ignoreCase: readOptionalBoolean(input, "ignore_case"),
        fixedStrings: readOptionalBoolean(input, "fixed_strings"),
        beforeContext: readOptionalNumber(input, "before_context") ?? contextLines,
        afterContext: readOptionalNumber(input, "after_context") ?? contextLines
      });
      return formatSearchMatches(matches, {
        outputMode,
        pattern: readString(input, "pattern"),
        lineNumbers: readOptionalBoolean(input, "line_numbers") ?? true
      });
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "Bash",
    description: "Run a shell command in the current workspace.",
    category: "shell",
    tags: ["bash", "command", "terminal"],
    inputSchema: objectSchema({
      command: { type: "string" },
      timeout_ms: { type: "number" }
    }, ["command"]),
    call: async (input, context) => {
      const result = await runShellCommand({
        cwd: context.cwd,
        command: readString(input, "command"),
        timeoutMs: readOptionalNumber(input, "timeout_ms"),
        approveDangerous: context.env?.MAGI_APPROVE_DANGEROUS_COMMANDS === "1"
      });
      return [
        `Command exited ${result.exitCode}`,
        result.stdout ? `stdout:\n${result.stdout.trimEnd()}` : undefined,
        result.stderr ? `stderr:\n${result.stderr.trimEnd()}` : undefined
      ].filter((line): line is string => Boolean(line)).join("\n");
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "GitSummary",
    description: "Return git branch, status, and diffstat for the current workspace.",
    category: "git",
    tags: ["git", "status", "diff"],
    inputSchema: objectSchema({}, []),
    call: (_input, context) => {
      const git = getGitSummary(context.cwd);
      if (!git.gitAvailable || !git.isRepository) {
        return git.reason ?? "Git summary is unavailable";
      }
      return [
        `branch: ${git.branch}`,
        git.status ? `status:\n${git.status}` : "status: clean",
        git.diffStat ? `diffStat:\n${git.diffStat}` : "diffStat: none"
      ].join("\n");
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "GitStatus",
    description: "Return git working tree status for the current workspace.",
    category: "git",
    tags: ["git", "status", "workspace"],
    inputSchema: objectSchema({
      path: { type: "string" },
      branch: { type: "boolean" },
      porcelain: { type: "boolean" },
      untracked: { type: "string" }
    }, []),
    call: (input, context) => getGitStatus(context.cwd, {
      path: readOptionalString(input, "path"),
      branch: readOptionalBoolean(input, "branch"),
      porcelain: readOptionalBoolean(input, "porcelain"),
      untracked: readGitUntracked(input, "untracked")
    }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "GitDiff",
    description: "Return git diff output for unstaged or staged workspace changes.",
    category: "git",
    tags: ["git", "diff", "workspace"],
    inputSchema: objectSchema({
      path: { type: "string" },
      staged: { type: "boolean" },
      stat: { type: "boolean" },
      name_only: { type: "boolean" },
      context: { type: "number" }
    }, []),
    call: (input, context) => getGitDiff(context.cwd, {
      path: readOptionalString(input, "path"),
      staged: readOptionalBoolean(input, "staged"),
      stat: readOptionalBoolean(input, "stat"),
      nameOnly: readOptionalBoolean(input, "name_only"),
      context: readOptionalNumber(input, "context")
    }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "GitLog",
    description: "Return recent git commits for the current workspace.",
    category: "git",
    tags: ["git", "log", "commits"],
    inputSchema: objectSchema({
      path: { type: "string" },
      max_count: { type: "number" },
      oneline: { type: "boolean" }
    }, []),
    call: (input, context) => getGitLog(context.cwd, {
      path: readOptionalString(input, "path"),
      maxCount: readOptionalNumber(input, "max_count"),
      oneline: readOptionalBoolean(input, "oneline")
    }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "GitShow",
    description: "Return a git object or commit using a simple revision name, tag, or commit id.",
    category: "git",
    tags: ["git", "show", "commit"],
    inputSchema: objectSchema({
      rev: { type: "string" },
      stat: { type: "boolean" },
      name_only: { type: "boolean" },
      max_bytes: { type: "number" }
    }, []),
    call: (input, context) => getGitShow(context.cwd, {
      rev: readOptionalString(input, "rev"),
      stat: readOptionalBoolean(input, "stat"),
      nameOnly: readOptionalBoolean(input, "name_only"),
      maxBytes: readOptionalNumber(input, "max_bytes")
    }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "GitBranchList",
    description: "List local or all branches for the current git workspace.",
    category: "git",
    tags: ["git", "branch", "list"],
    inputSchema: objectSchema({
      all: { type: "boolean" }
    }, []),
    call: (input, context) => listGitBranches(context.cwd, {
      all: readOptionalBoolean(input, "all")
    }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "GitBranchCreate",
    description: "Create a new git branch, optionally checking it out.",
    category: "git",
    tags: ["git", "branch", "create", "mutation"],
    inputSchema: objectSchema({
      name: { type: "string" },
      start_point: { type: "string" },
      checkout: { type: "boolean" }
    }, ["name"]),
    call: (input, context) => createGitBranch(context.cwd, {
      name: readString(input, "name"),
      startPoint: readOptionalString(input, "start_point"),
      checkout: readOptionalBoolean(input, "checkout")
    }),
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "GitCheckout",
    description: "Check out an existing git branch, or create and check out a new branch.",
    category: "git",
    tags: ["git", "checkout", "branch", "mutation"],
    inputSchema: objectSchema({
      branch: { type: "string" },
      create: { type: "boolean" },
      start_point: { type: "string" }
    }, ["branch"]),
    call: (input, context) => checkoutGitBranch(context.cwd, {
      branch: readString(input, "branch"),
      create: readOptionalBoolean(input, "create"),
      startPoint: readOptionalString(input, "start_point")
    }),
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "GitStage",
    description: "Stage or unstage specific workspace paths.",
    category: "git",
    tags: ["git", "stage", "index", "mutation"],
    inputSchema: objectSchema({
      paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
      mode: { type: "string" }
    }, ["paths"]),
    call: (input, context) => stageGitPaths(context.cwd, {
      paths: readStringArray(input, "paths"),
      mode: readGitStageMode(input, "mode")
    }),
    isReadOnly: () => false,
    isDestructive: (input) => input.mode === "unstage",
    isConcurrencySafe: () => false
  },
  {
    name: "WebFetch",
    description: "Fetch a web page and use the active model to extract information from it.",
    category: "web",
    tags: ["web", "fetch", "http", "summarize"],
    inputSchema: objectSchema({
      url: { type: "string" },
      prompt: { type: "string" },
      max_bytes: { type: "number" }
    }, ["url", "prompt"]),
    call: async (input, context) => {
      if (!context.promptModel) {
        throw new Error("WebFetch requires an active model route");
      }
      const result = await webFetch({
        url: readString(input, "url"),
        prompt: readString(input, "prompt"),
        maxBytes: readOptionalNumber(input, "max_bytes"),
        promptModel: context.promptModel
      });
      return [
        `Title: ${result.title}`,
        `URL: ${result.url}`,
        `Fetched bytes: ${result.fetchedBytes}`,
        "",
        result.summary
      ].join("\n");
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: (input, context) => {
      const url = readString(input, "url");
      const allowed = webFetchHostAllowed(url, readWebFetchAllowlist(context.env));
      if (allowed) {
        return { decision: "allow", reason: "WebFetch URL is allowlisted" };
      }
      if (context.permissionMode === "bypassPermissions") {
        return { decision: "allow", reason: "bypassPermissions mode" };
      }
      return { decision: "ask", reason: `WebFetch requires approval for ${new URL(url).hostname}` };
    }
  },
  {
    name: "WebSearch",
    description: "Search the web through the configured Magi Next HTTP JSON search provider.",
    category: "web",
    tags: ["web", "search", "http", "sources"],
    inputSchema: WebSearchInputSchema,
    call: async (input, context) => {
      const request = parseWebSearchInput(input);
      // Fallback: if no endpoint configured, silently use WebBrowser (Bing HTML)
      if (!context.webSearchConfig || !context.webSearchConfig.endpoint) {
        const browserResult = await executeWebBrowser({
          action: "search",
          query: request.query,
          maxResults: request.maxResults
        });
        return formatWebBrowserResult(browserResult);
      }
      const result = await webSearch({
        request,
        config: context.webSearchConfig,
        env: context.env
      });
      return formatWebSearchResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "WebBrowser",
    description: "Browse the web: search via DuckDuckGo (no API key needed) or fetch a URL and extract readable text.",
    category: "web",
    tags: ["web", "browser", "search", "fetch", "duckduckgo"],
    inputSchema: WebBrowserInputSchema,
    call: async (input) => {
      const parsed = parseWebBrowserInput(input);
      const result = await executeWebBrowser(parsed);
      return formatWebBrowserResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "AskUserQuestion",
    description: "Ask the user 1 to 4 structured multiple-choice questions and return their selections.",
    category: "communication",
    tags: ["user", "question", "approval", "choice"],
    inputSchema: ASK_USER_QUESTION_SCHEMA,
    call: async (input, context) => {
      if (!context.userQuestionResolver) {
        throw new Error("AskUserQuestion requires an interactive user question resolver");
      }
      const request = parseAskUserQuestionInput(input);
      const rawAnswer = await context.userQuestionResolver({
        toolUse: context.toolUse ?? { type: "tool-use", id: "AskUserQuestion", name: "AskUserQuestion", input },
        question: request
      });
      return formatAskUserQuestionAnswer(normalizeAskUserQuestionAnswer(request, rawAnswer));
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "SendUserMessage",
    description: "Send a markdown message from the agent to the user, optionally with attachments.",
    category: "communication",
    tags: ["user", "message", "notification"],
    inputSchema: SEND_USER_MESSAGE_SCHEMA,
    call: async (input, context) => {
      const request = parseSendUserMessageInput(input);
      const result = await (context.userMessageSink ?? defaultUserMessageSink)({
        toolUse: context.toolUse ?? { type: "tool-use", id: "SendUserMessage", name: "SendUserMessage", input },
        message: request
      });
      return formatSendUserMessageResult(request, result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "Brief",
    description: "Alias of SendUserMessage for concise agent-to-user updates.",
    category: "communication",
    tags: ["user", "message", "brief"],
    inputSchema: SEND_USER_MESSAGE_SCHEMA,
    call: async (input, context) => {
      const request = parseSendUserMessageInput(input);
      const result = await (context.userMessageSink ?? defaultUserMessageSink)({
        toolUse: context.toolUse ?? { type: "tool-use", id: "Brief", name: "Brief", input },
        message: request
      });
      return formatSendUserMessageResult(request, result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "CronCreate",
    description: "Create a 5-field local-time cron job that queues a prompt for future execution.",
    category: "schedule",
    tags: ["cron", "schedule", "job"],
    inputSchema: CRON_CREATE_SCHEMA,
    call: (input, context) => {
      const job = addCronJob(requireStateFile(context), {
        cron: readString(input, "cron"),
        prompt: readString(input, "prompt"),
        recurring: readOptionalBoolean(input, "recurring"),
        durable: readOptionalBoolean(input, "durable")
      });
      return `Created cron job\n${formatCronJob(job)}`;
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "CronUpdate",
    description: "Update an existing cron job by id.",
    category: "schedule",
    tags: ["cron", "schedule", "update"],
    inputSchema: CRON_UPDATE_SCHEMA,
    call: (input, context) => {
      const job = applyCronUpdate(requireStateFile(context), {
        id: readString(input, "id"),
        cron: readOptionalString(input, "cron"),
        prompt: readOptionalString(input, "prompt"),
        recurring: readOptionalBoolean(input, "recurring"),
        durable: readOptionalBoolean(input, "durable"),
        enabled: readOptionalBoolean(input, "enabled")
      });
      return `Updated cron job\n${formatCronJob(job)}`;
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "CronDelete",
    description: "Delete an existing cron job by id.",
    category: "schedule",
    tags: ["cron", "schedule", "delete"],
    inputSchema: CRON_DELETE_SCHEMA,
    call: (input, context) => {
      const job = deleteCronJob(requireStateFile(context), readString(input, "id"));
      return `Deleted cron job\n${formatCronJob(job)}`;
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "CronList",
    description: "List all configured cron jobs.",
    category: "schedule",
    tags: ["cron", "schedule", "list"],
    inputSchema: CRON_LIST_SCHEMA,
    call: (_input, context) => formatCronList(listCronJobs(requireStateFile(context))),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "TodoWrite",
    description: "Replace the current session todo list with a validated complete list.",
    category: "state",
    tags: ["todo", "plan", "state"],
    inputSchema: TodoWriteInputSchema,
    call: async (input, context) => {
      const todoContext = requireTodoContext(context);
      return formatTodoWriteResult(await replaceTodoList({
        stateRoot: todoContext.stateRoot,
        sessionId: todoContext.sessionId,
        todos: parseTodoWriteInput(input)
      }));
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "TaskCreate",
    description: "Create a new task to track progress on multi-step work.",
    category: "state",
    tags: ["task", "create", "progress"],
    inputSchema: TaskCreateInputSchema,
    call: (input, context) => {
      const todoContext = requireTodoContext(context);
      return formatTaskCreateResult(executeTaskCreate({
        stateRoot: todoContext.stateRoot,
        sessionId: todoContext.sessionId,
        task: parseTaskCreateInput(input)
      }));
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "TaskUpdate",
    description: "Update a task's status, subject, or priority. Set status to 'deleted' to remove.",
    category: "state",
    tags: ["task", "update", "progress"],
    inputSchema: TaskUpdateInputSchema,
    call: (input, context) => {
      const todoContext = requireTodoContext(context);
      return formatTaskUpdateResult(executeTaskUpdate({
        stateRoot: todoContext.stateRoot,
        sessionId: todoContext.sessionId,
        update: parseTaskUpdateInput(input)
      }));
    },
    isReadOnly: () => false,
    isDestructive: (input) => input.status === "deleted",
    isConcurrencySafe: () => false
  },
  {
    name: "TaskList",
    description: "List all tasks in the current session.",
    category: "state",
    tags: ["task", "list", "progress"],
    inputSchema: TaskListInputSchema,
    call: (_input, context) => {
      const todoContext = requireTodoContext(context);
      return formatTaskListResult(executeTaskList({
        stateRoot: todoContext.stateRoot,
        sessionId: todoContext.sessionId
      }));
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "TaskGet",
    description: "Retrieve a task by ID with full details including description and status.",
    category: "state",
    tags: ["task", "get", "detail"],
    inputSchema: TaskGetInputSchema,
    call: (input, context) => {
      const todoContext = requireTodoContext(context);
      return formatTaskGetResult(executeTaskGet({
        stateRoot: todoContext.stateRoot,
        sessionId: todoContext.sessionId,
        taskId: readString(input, "taskId")
      }));
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "TaskOutput",
    description: "Retrieve output from a running or completed background task.",
    category: "state",
    tags: ["task", "output", "background"],
    inputSchema: TaskOutputInputSchema,
    call: async (input, context) => {
      const todoContext = requireTodoContext(context);
      return formatTaskOutputResult(await executeTaskOutput({
        stateRoot: todoContext.stateRoot,
        sessionId: todoContext.sessionId,
        taskId: readString(input, "taskId")
      }));
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "TaskStop",
    description: "Stop a running background task by its ID.",
    category: "state",
    tags: ["task", "stop", "cancel"],
    inputSchema: TaskStopInputSchema,
    call: async (input, context) => {
      const todoContext = requireTodoContext(context);
      return formatTaskStopResult(await executeTaskStop({
        stateRoot: todoContext.stateRoot,
        sessionId: todoContext.sessionId,
        taskId: readString(input, "taskId")
      }));
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "ToolSearch",
    description: "Search built-in tool documentation or select one tool by name for its full schema.",
    category: "tools",
    tags: ["tool", "search", "schema", "docs"],
    inputSchema: ToolSearchInputSchema,
    call: (input) => executeToolSearch(parseToolSearchInput(input), BUILTIN_TOOLS),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "WorkspaceDiagnostics",
    description: "Inspect the current workspace for manifests, languages, package scripts, suggested commands, and git status without executing project commands.",
    category: "workspace",
    tags: ["workspace", "diagnostics", "scripts", "setup"],
    inputSchema: WorkspaceDiagnosticsInputSchema,
    call: (input, context) => {
      const request = parseWorkspaceDiagnosticsInput(input);
      return formatWorkspaceDiagnostics(runWorkspaceDiagnostics({
        cwd: context.cwd,
        request
      }), request.format);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "Config",
    description: "Read or update allowlisted Magi Next configuration settings.",
    category: "config",
    tags: ["config", "settings", "magi"],
    inputSchema: ConfigToolInputSchema,
    call: (input, context) => executeConfigTool({
      request: parseConfigToolInput(input),
      configFile: requireConfigFile(context),
      env: context.env
    }),
    isReadOnly: (input) => input.value === undefined,
    isDestructive: () => false,
    isConcurrencySafe: (input) => input.value === undefined
  },
  {
    name: "Memorize",
    description: "Save a durable memory (memdir entry) for future conversations. Use sparingly for genuine user preferences, project facts, corrections, or reference pointers — not for ephemeral conversation state.",
    category: "memory",
    tags: ["memory", "memdir", "persist"],
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description: "Memory type. user=facts about the user, feedback=corrections/preferences, project=ongoing work facts, reference=pointers to external systems."
        },
        name: { type: "string", minLength: 1, maxLength: 80, description: "Short title (e.g. 'User role', 'Prefers tabs over spaces')." },
        description: { type: "string", minLength: 1, maxLength: 200, description: "One-line description used to decide relevance in future conversations." },
        body: { type: "string", minLength: 1, maxLength: 4000, description: "Memory content. For feedback/project entries, include why and how to apply." }
      },
      required: ["type", "name", "description", "body"]
    },
    call: (input, context) => {
      const type = String((input as Record<string, unknown>).type ?? "");
      if (!isValidMemdirType(type)) {
        throw new Error(`Invalid memory type: ${type}`);
      }
      const name = String((input as Record<string, unknown>).name ?? "").trim();
      const description = String((input as Record<string, unknown>).description ?? "").trim();
      const body = String((input as Record<string, unknown>).body ?? "").trim();
      if (!name || !description || !body) {
        throw new Error("Memorize requires name, description, and body");
      }
      if (!context.stateRoot) {
        throw new Error("Memorize requires Magi stateRoot");
      }
      const root = path.dirname(context.stateRoot);
      const entry = writeMemdirEntry({
        paths: { root },
        type,
        name,
        description,
        body
      });
      return `Saved memory: ${entry.filename} (type=${entry.type})`;
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "Skill",
    description: "List installed Magi Next skills or load one skill's instructions by name.",
    category: "skills",
    tags: ["skill", "instructions", "workflow"],
    inputSchema: SkillToolInputSchema,
    call: (input, context) => executeSkillTool({
      request: parseSkillToolInput(input),
      skillsRoot: requireSkillsRoot(context)
    }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "LSP",
    description: "Run TypeScript/JavaScript workspace symbol, definition, reference, and hover queries.",
    category: "lsp",
    tags: ["lsp", "typescript", "symbols", "references"],
    inputSchema: LSP_SCHEMA,
    call: (input, context) => executeLspRequest({
      cwd: context.cwd,
      request: parseLspRequest(input)
    }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "EnterPlanMode",
    description: "Switch to plan mode for non-trivial tasks. Blocks mutations until the plan is approved by the user.",
    category: "planning",
    tags: ["plan", "mode", "architecture"],
    inputSchema: EnterPlanModeInputSchema,
    call: (input) => formatEnterPlanModeResult(parseEnterPlanModeInput(input)),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "ExitPlanMode",
    description: "Submit the implementation plan for user approval and exit plan mode.",
    category: "planning",
    tags: ["plan", "mode", "approval"],
    inputSchema: ExitPlanModeInputSchema,
    call: async (input, context) => {
      const parsed = parseExitPlanModeInput(input);
      // Ask the user to approve or reject the plan
      if (context.userQuestionResolver && context.toolUse) {
        try {
          const answer = await context.userQuestionResolver({
            toolUse: context.toolUse,
            question: {
              questions: [
                {
                  question: "Do you approve this plan and want me to proceed with implementation?",
                  header: "Plan review",
                  options: [
                    { label: "Yes, proceed", description: "Approve the plan and start implementing" },
                    { label: "No, revise", description: "I want to give feedback or change the approach" }
                  ],
                  multiSelect: false
                }
              ]
            }
          });
          const selection = answer.answers?.[0];
          const approved = selection?.selectedLabels?.includes("Yes, proceed") ?? false;
          if (approved) {
            return [
              "Plan approved. Proceeding with implementation.",
              "",
              "---",
              parsed.plan,
              "---"
            ].join("\n");
          }
          const feedback = selection?.selectedLabels?.join(", ") ?? "User wants to revise the plan.";
          return [
            `Plan not approved. User response: ${feedback}`,
            "",
            "Stay in plan mode. Revise the approach based on the feedback above and call ExitPlanMode again with an updated plan."
          ].join("\n");
        } catch {
          return formatExitPlanModeResult(parsed);
        }
      }
      return formatExitPlanModeResult(parsed);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "EnterWorktree",
    description: "Create an isolated git worktree for safe agent execution. Changes do not affect the main working tree.",
    category: "git",
    tags: ["git", "worktree", "isolation", "mutation"],
    inputSchema: EnterWorktreeInputSchema,
    call: async (input, context) => {
      const parsed = parseEnterWorktreeInput(input);
      const state = executeEnterWorktree({ cwd: context.cwd, name: parsed.name });
      // Persist worktree state in the session so ExitWorktree can find it
      if (context.sessionId && context.stateRoot) {
        try {
          const dbPath = path.join(context.stateRoot, "sessions.sqlite");
          if (existsSync(dbPath)) {
            const mod = await import("../session-store.js");
            const store = new mod.SessionStore(dbPath);
            try {
              store.updateSessionMetadata(context.sessionId, { worktree: state });
            } finally {
              store.close();
            }
          }
        } catch {
          // Best effort — the worktree itself is created, state just isn't persisted
        }
      }
      return formatEnterWorktreeResult(state);
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "ExitWorktree",
    description: "Exit the current worktree session. Use action 'keep' to preserve or 'remove' to delete.",
    category: "git",
    tags: ["git", "worktree", "cleanup"],
    inputSchema: ExitWorktreeInputSchema,
    call: async (input, context) => {
      const parsed = parseExitWorktreeInput(input);
      // Try to find the worktree state for this session
      let state: WorktreeState | undefined;
      if (context.sessionId && context.stateRoot) {
        try {
          const dbPath = path.join(context.stateRoot, "sessions.sqlite");
          if (existsSync(dbPath)) {
            const mod = await import("../session-store.js");
            const store = new mod.SessionStore(dbPath);
            try {
              const session = store.getSession(context.sessionId);
              const meta = session?.metadata as Record<string, unknown> | undefined;
              if (meta && meta.worktree && typeof meta.worktree === "object") {
                state = meta.worktree as WorktreeState;
              }
              if (parsed.action === "remove" && state) {
                // Clear from metadata
                store.updateSessionMetadata(context.sessionId, { worktree: undefined });
              }
            } finally {
              store.close();
            }
          }
        } catch {
          // Best effort
        }
      }
      if (!state) {
        return [
          "No active worktree session found.",
          "If you created a worktree manually with `git worktree add`, this tool only operates on worktrees created by EnterWorktree."
        ].join("\n");
      }
      const result = executeExitWorktree({
        cwd: context.cwd,
        state,
        action: parsed.action,
        discardChanges: parsed.discardChanges
      });
      return formatExitWorktreeResult(result);
    },
    isReadOnly: () => false,
    isDestructive: (input) => input.action === "remove",
    isConcurrencySafe: () => false
  },
  {
    name: "GitHubIssueView",
    description: "View a GitHub issue by number or URL using the gh CLI.",
    category: "github",
    tags: ["github", "issue", "read"],
    inputSchema: GitHubIssueViewInputSchema,
    call: (input, context) => ghIssueView(context.cwd, readString(input, "issue")),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "GitHubPRView",
    description: "View a GitHub pull request by number or URL using the gh CLI.",
    category: "github",
    tags: ["github", "pr", "read"],
    inputSchema: GitHubPRViewInputSchema,
    call: (input, context) => ghPRView(context.cwd, readString(input, "pr")),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "GitHubPRList",
    description: "List GitHub pull requests for the current repository.",
    category: "github",
    tags: ["github", "pr", "list"],
    inputSchema: GitHubPRListInputSchema,
    call: (input, context) => ghPRList(context.cwd, {
      state: readOptionalString(input, "state"),
      limit: readOptionalNumber(input, "limit"),
      author: readOptionalString(input, "author"),
      label: readOptionalString(input, "label")
    }),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "GitHubPRDiff",
    description: "View the diff of a GitHub pull request.",
    category: "github",
    tags: ["github", "pr", "diff"],
    inputSchema: GitHubPRDiffInputSchema,
    call: (input, context) => ghPRDiff(context.cwd, readString(input, "pr")),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "Snip",
    description: "Take a screenshot of the current screen and save it to a file.",
    category: "system",
    tags: ["screenshot", "snip", "image"],
    inputSchema: SnipInputSchema,
    call: async (input, context) => {
      const parsed = parseSnipInput(input);
      const result = await executeSnip({
        format: parsed.format,
        cwd: context.cwd
      });
      return formatSnipResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "SshExec",
    description: "Run a shell command on a remote host via SSH.",
    category: "ssh",
    tags: ["ssh", "remote", "shell"],
    inputSchema: objectSchema({
      host: { type: "string" },
      command: { type: "string" },
      user: { type: "string" },
      port: { type: "number" },
      timeoutMs: { type: "number" }
    }, ["host", "command"]),
    call: async (input, context) => {
      const result = await sshExec({
        host: readString(input, "host"),
        command: readString(input, "command"),
        user: readOptionalString(input, "user"),
        port: readOptionalNumber(input, "port"),
        timeoutMs: readOptionalNumber(input, "timeoutMs")
      });
      return [
        `Host: ${result.host}`,
        `Command: ${result.command}`,
        `Exit code: ${result.exitCode}`,
        result.stdout ? `\n${result.stdout}` : "",
        result.stderr ? `\nstderr:\n${result.stderr}` : ""
      ].filter(Boolean).join("\n");
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "SshFileRead",
    description: "Read a file from a remote host via SSH.",
    category: "ssh",
    tags: ["ssh", "remote", "file", "read"],
    inputSchema: objectSchema({
      host: { type: "string" },
      path: { type: "string" },
      user: { type: "string" },
      port: { type: "number" }
    }, ["host", "path"]),
    call: async (input, context) => {
      const result = await sshFileRead({
        host: readString(input, "host"),
        path: readString(input, "path"),
        user: readOptionalString(input, "user"),
        port: readOptionalNumber(input, "port")
      });
      return `Read ${result.path} on ${result.host} (${result.sizeBytes} bytes)\n${result.content}`;
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  },
  {
    name: "SshFileWrite",
    description: "Write a file to a remote host via SSH.",
    category: "ssh",
    tags: ["ssh", "remote", "file", "write"],
    inputSchema: objectSchema({
      host: { type: "string" },
      path: { type: "string" },
      content: { type: "string" },
      user: { type: "string" },
      port: { type: "number" }
    }, ["host", "path", "content"]),
    call: async (input, context) => {
      const result = await sshFileWrite({
        host: readString(input, "host"),
        path: readString(input, "path"),
        content: readString(input, "content"),
        user: readOptionalString(input, "user"),
        port: readOptionalNumber(input, "port")
      });
      return `Wrote ${result.path} on ${result.host} (${result.sizeBytes} bytes)`;
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "Sleep",
    description: "Pause execution for a specified number of milliseconds.",
    category: "system",
    tags: ["sleep", "wait", "delay"],
    inputSchema: SleepInputSchema,
    call: async (input) => {
      const parsed = parseSleepInput(input);
      return executeSleep(parsed);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "Monitor",
    description: "Show system resource usage (CPU, memory, disk).",
    category: "system",
    tags: ["monitor", "system", "resources"],
    inputSchema: MonitorInputSchema,
    call: (input) => {
      const parsed = parseMonitorInput(input);
      const data = getMonitorData();
      return formatMonitorResult(data, parsed.scope ?? "quick");
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "FileCopy",
    description: "Copy a file with safety checks (refuses overwrite without overwrite flag).",
    category: "files",
    tags: ["file", "copy"],
    inputSchema: FileCopyInputSchema,
    call: (input, context) => {
      const parsed = parseFileCopyInput(input);
      const result = executeFileCopy({ ...parsed, cwd: context.cwd });
      return formatFileCopyResult(result);
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "FileMove",
    description: "Move or rename a file with safety checks.",
    category: "files",
    tags: ["file", "move", "rename"],
    inputSchema: FileMoveInputSchema,
    call: (input, context) => {
      const parsed = parseFileMoveInput(input);
      const result = executeFileMove({ ...parsed, cwd: context.cwd });
      return formatFileMoveResult(result);
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "FileDelete",
    description: "Delete a file or directory with path safety checks.",
    category: "files",
    tags: ["file", "delete", "remove"],
    inputSchema: FileDeleteInputSchema,
    call: (input, context) => {
      const parsed = parseFileDeleteInput(input);
      const result = executeFileDelete({ ...parsed, cwd: context.cwd });
      return formatFileDeleteResult(result);
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "DirCreate",
    description: "Create a directory (recursive).",
    category: "files",
    tags: ["file", "directory", "create", "mkdir"],
    inputSchema: DirCreateInputSchema,
    call: (input, context) => {
      const parsed = parseDirCreateInput(input);
      const result = executeDirCreate({ ...parsed, cwd: context.cwd });
      return formatDirCreateResult(result);
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "DirList",
    description: "List directory contents with file sizes and modification dates.",
    category: "files",
    tags: ["file", "directory", "list", "ls"],
    inputSchema: DirListInputSchema,
    call: (input, context) => {
      const parsed = parseDirListInput(input);
      const result = executeDirList({ ...parsed, cwd: context.cwd });
      return formatDirListResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "ProcessList",
    description: "List running processes sorted by CPU or memory usage.",
    category: "system",
    tags: ["process", "ps", "system"],
    inputSchema: ProcessListInputSchema,
    call: (input) => {
      const parsed = parseProcessListInput(input);
      const result = executeProcessList(parsed);
      return formatProcessListResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "KillProcess",
    description: "Kill a process by PID or process name.",
    category: "system",
    tags: ["process", "kill", "signal"],
    inputSchema: KillProcessInputSchema,
    call: (input) => {
      const parsed = parseKillProcessInput(input);
      const result = executeKillProcess(parsed);
      return formatKillProcessResult(result);
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "Environment",
    description: "Show environment variables with optional filtering.",
    category: "system",
    tags: ["env", "environment"],
    inputSchema: EnvironmentInputSchema,
    call: (input) => {
      const parsed = parseEnvironmentInput(input);
      const result = executeEnvironment(parsed);
      return formatEnvironmentResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "DiskUsage",
    description: "Show disk usage for a path.",
    category: "system",
    tags: ["disk", "df", "usage"],
    inputSchema: DiskUsageInputSchema,
    call: (input) => {
      const parsed = parseDiskUsageInput(input);
      const result = executeDiskUsage(parsed);
      return formatDiskUsageResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "SystemInfo",
    description: "Show system information: hostname, OS, uptime, load, users, processes.",
    category: "system",
    tags: ["system", "uptime", "info"],
    inputSchema: SystemInfoInputSchema,
    call: () => {
      const result = executeSystemInfo();
      return formatSystemInfoResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "HttpRequest",
    description: "Send an HTTP request (GET/POST/PUT/DELETE) with custom headers and body.",
    category: "web",
    tags: ["http", "api", "request"],
    inputSchema: HttpRequestInputSchema,
    call: async (input) => {
      const parsed = parseHttpRequestInput(input);
      const result = await executeHttpRequest(parsed);
      return formatHttpRequestResult(result);
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "JsonQuery",
    description: "Query/filter JSON data using simple path expressions (e.g., items[0].name).",
    category: "data",
    tags: ["json", "query", "parse"],
    inputSchema: JsonQueryInputSchema,
    call: (input) => {
      const parsed = parseJsonQueryInput(input);
      const result = executeJsonQuery(parsed);
      return formatJsonQueryResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "ArchiveCreate",
    description: "Create a tar.gz or zip archive from files or directories.",
    category: "files",
    tags: ["archive", "tar", "zip", "compress"],
    inputSchema: ArchiveCreateInputSchema,
    call: (input, context) => {
      const parsed = parseArchiveCreateInput(input);
      const result = executeArchiveCreate({ ...parsed, cwd: context.cwd });
      return formatArchiveCreateResult(result);
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "ArchiveExtract",
    description: "Extract a tar.gz or zip archive to a directory.",
    category: "files",
    tags: ["archive", "tar", "zip", "extract"],
    inputSchema: ArchiveExtractInputSchema,
    call: (input, context) => {
      const parsed = parseArchiveExtractInput(input);
      const result = executeArchiveExtract({ ...parsed, cwd: context.cwd });
      return formatArchiveExtractResult(result);
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "GitBranchDelete",
    description: "Delete a git branch (refuses if it is the current branch).",
    category: "git",
    tags: ["git", "branch", "delete"],
    inputSchema: GitBranchDeleteInputSchema,
    call: (input, context) => {
      const parsed = parseGitBranchDeleteInput(input);
      const result = executeGitBranchDelete({ ...parsed, cwd: context.cwd });
      return formatGitBranchDeleteResult(result);
    },
    isReadOnly: () => false,
    isDestructive: () => true,
    isConcurrencySafe: () => false
  },
  {
    name: "GitStash",
    description: "Stash, pop, list, drop, or apply git stashes.",
    category: "git",
    tags: ["git", "stash"],
    inputSchema: GitStashInputSchema,
    call: (input, context) => {
      const parsed = parseGitStashInput(input);
      const result = executeGitStash({ ...parsed, cwd: context.cwd });
      return formatGitStashResult(result);
    },
    isReadOnly: (input) => (input.action as string) === "list",
    isDestructive: (input) => (input.action as string) !== "list",
    isConcurrencySafe: () => false
  },
  {
    name: "GitReset",
    description: "Unstage files or hard-reset the working tree.",
    category: "git",
    tags: ["git", "reset", "unstage"],
    inputSchema: GitResetInputSchema,
    call: (input, context) => {
      const parsed = parseGitResetInput(input);
      const result = executeGitReset({ ...parsed, cwd: context.cwd });
      return formatGitResetResult(result);
    },
    isReadOnly: () => false,
    isDestructive: (input) => (input.hard as boolean) === true,
    isConcurrencySafe: () => false
  },
  {
    name: "FileFind",
    description: "Find files by name pattern, size range, or modification time.",
    category: "search",
    tags: ["find", "file", "search"],
    inputSchema: FileFindInputSchema,
    call: (input, context) => {
      const parsed = parseFileFindInput(input);
      const result = executeFileFind({ ...parsed, cwd: context.cwd });
      return formatFileFindResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "HeadTail",
    description: "Read the first or last N lines of a file.",
    category: "files",
    tags: ["file", "head", "tail", "read"],
    inputSchema: HeadTailInputSchema,
    call: (input, context) => {
      const parsed = parseHeadTailInput(input);
      const result = executeHeadTail({ ...parsed, cwd: context.cwd });
      return formatHeadTailResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "TextStats",
    description: "Count lines, words, characters, and bytes in a file.",
    category: "files",
    tags: ["file", "count", "wc", "stats"],
    inputSchema: TextStatsInputSchema,
    call: (input, context) => {
      const parsed = parseTextStatsInput(input);
      const result = executeTextStats({ ...parsed, cwd: context.cwd });
      return formatTextStatsResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "TreeView",
    description: "Show a directory tree of the workspace (depth-limited).",
    category: "search",
    tags: ["tree", "directory", "ls"],
    inputSchema: TreeViewInputSchema,
    call: (input, context) => {
      const parsed = parseTreeViewInput(input);
      const result = executeTreeView({ ...parsed, cwd: context.cwd });
      return formatTreeViewResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "WhoAmI",
    description: "Show current user information (username, home, shell, groups).",
    category: "system",
    tags: ["user", "whoami"],
    inputSchema: WhoAmIInputSchema,
    call: () => {
      const result = executeWhoAmI();
      return formatWhoAmIResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "NetworkCheck",
    description: "Check if a host is reachable via ping or TCP port check.",
    category: "system",
    tags: ["network", "ping", "connectivity"],
    inputSchema: NetworkCheckInputSchema,
    call: async (input) => {
      const parsed = parseNetworkCheckInput(input);
      const result = await executeNetworkCheck(parsed);
      return formatNetworkCheckResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "Base64",
    description: "Encode or decode base64 strings.",
    category: "data",
    tags: ["base64", "encode", "decode"],
    inputSchema: Base64InputSchema,
    call: (input) => {
      const parsed = parseBase64Input(input);
      const result = executeBase64(parsed);
      return formatBase64Result(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "Which",
    description: "Locate an executable in the system PATH.",
    category: "system",
    tags: ["which", "path", "executable"],
    inputSchema: WhichInputSchema,
    call: (input) => {
      const parsed = parseWhichInput(input);
      const result = executeWhich(parsed);
      return formatWhichResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "Date",
    description: "Show current date/time in ISO, Unix, UTC, and local formats.",
    category: "system",
    tags: ["date", "time"],
    inputSchema: DateInputSchema,
    call: () => {
      const result = executeDate();
      return formatDateResult(result);
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "Agent",
    description: "Spawn a sub-agent to handle complex tasks autonomously, preserving the main context window.",
    category: "agent",
    tags: ["agent", "subagent", "parallel", "research"],
    inputSchema: AgentToolInputSchema,
    call: async (input, context) => {
      const parsed = parseAgentToolInput(input);
      if (!context.spawnSubAgent) {
        throw new Error("Agent tool requires a spawnSubAgent executor (not available in this context)");
      }
      const result = await context.spawnSubAgent({
        prompt: parsed.prompt,
        description: parsed.description,
        subagentType: parsed.subagentType ?? "general",
        runInBackground: parsed.runInBackground ?? false,
        target: parsed.target
      });
      return formatAgentToolResult({
        agentId: result.agentId,
        type: (parsed.subagentType ?? "general") as import("./agent-tool.js").SubagentType,
        status: result.status,
        result: result.result,
        error: result.error
      });
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "ListPeers",
    description: "List all Magi peers reachable on the local network. Use this to discover targets for the Agent tool's `target` parameter when distributing work across multiple machines. Returns peer name, address, and status.",
    category: "agent",
    tags: ["agent", "peers", "swarm", "discovery"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        timeoutMs: {
          type: "integer",
          minimum: 500,
          maximum: 10000,
          description: "How long to wait for mDNS responses (default 2500ms)"
        }
      }
    },
    call: async (input) => {
      const timeoutMs = typeof (input as Record<string, unknown>).timeoutMs === "number"
        ? (input as Record<string, number>).timeoutMs
        : 2500;
      // Discover via mDNS
      const { browseMdns } = await import("../control/mdns.js");
      const browser = browseMdns({});
      await new Promise(resolve => setTimeout(resolve, timeoutMs));
      const peers = browser.peers();
      browser.stop();
      // Also include saved peers (manually configured with credentials)
      // Note: we read from a stand-alone SessionStore; saved peers are stored as
      // mcp_oauth_tokens with serverName starting with "peer:".
      let savedPeers: Array<{ name: string; url: string }> = [];
      try {
        const path = await import("node:path");
        const { existsSync } = await import("node:fs");
        const stateDir = process.env.MAGI_HOME
          ? path.join(process.env.MAGI_HOME, "state")
          : path.join(process.env.HOME ?? "/tmp", ".magi-next", "state");
        const dbPath = path.join(stateDir, "sessions.sqlite");
        if (existsSync(dbPath)) {
          const mod = await import("../session-store.js");
          const store = new mod.SessionStore(dbPath);
          savedPeers = store.listMcpOAuthTokens()
            .filter(t => t.serverName.startsWith("peer:"))
            .map(t => ({
              name: t.serverName.replace(/^peer:/, ""),
              url: ((t.metadata as Record<string, unknown>)?.peerUrl as string) ?? t.authServerUrl ?? "?"
            }));
          store.close();
        }
      } catch {
        // best effort
      }
      const lines: string[] = [];
      if (peers.length === 0 && savedPeers.length === 0) {
        return [
          "No peers found.",
          "",
          "To add a peer:",
          "  1. On the remote machine: `magi daemon start` and `magi pair`",
          "  2. On this machine: `magi peers add <name> <url> <device-id> <token>`",
          "  3. Use Agent({ target: <name>, ... }) to dispatch to it."
        ].join("\n");
      }
      if (peers.length > 0) {
        lines.push(`Discovered ${peers.length} peer(s) via mDNS:`);
        for (const p of peers) {
          lines.push(`  ${p.instanceName.padEnd(28)} ${p.address}:${p.port}  ${p.hostname}`);
          if (p.txt && Object.keys(p.txt).length > 0) {
            lines.push(`    info: ${Object.entries(p.txt).map(([k, v]) => `${k}=${v}`).join(", ")}`);
          }
        }
      }
      if (savedPeers.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push(`${savedPeers.length} saved peer(s) with credentials (use these as Agent target):`);
        for (const p of savedPeers) {
          lines.push(`  ${p.name.padEnd(28)} ${p.url}`);
        }
      }
      lines.push("");
      lines.push("To dispatch a sub-agent to a peer, call:");
      lines.push("  Agent({ target: <peer-name>, subagent_type: <type>, prompt: <task>, description: <short> })");
      lines.push("Multiple Agent calls in the same response run in parallel — split work across peers for speed.");
      return lines.join("\n");
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "DiscoverSkills",
    description: "List user-installed skills with their descriptions. Skills are reusable workflows; invoke them by replying with their name as a slash command (e.g. `/verify`) or calling the Skill tool with the skill name.",
    category: "agent",
    tags: ["skills", "discovery"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    },
    call: async (_input, context) => {
      if (!context.stateRoot) {
        return "Skills require a configured Magi state root.";
      }
      const skillsRoot = path.join(path.dirname(context.stateRoot), "skills");
      const { listSkills } = await import("../skills/loader.js");
      const fakePaths = { skillsRoot } as Record<string, string>;
      const skills = listSkills(fakePaths as never);
      if (skills.length === 0) {
        return [
          "No skills installed.",
          `Skills directory: ${skillsRoot}`,
          "Bundled skills (verify, debug, stuck) are auto-installed on first run."
        ].join("\n");
      }
      const lines = ["Installed skills:", ""];
      for (const s of skills) {
        lines.push(`  /${s.name.padEnd(20)} ${s.summary}`);
      }
      lines.push("");
      lines.push("To run a skill: reply with its name as a slash command, or call Skill({name: \"...\"}).");
      return lines.join("\n");
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "CtxInspect",
    description: "Show the current session's context size: message count, approximate token usage, and the most recent message titles. Use to decide whether to compact the session.",
    category: "agent",
    tags: ["context", "introspection"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    },
    call: async (_input, context) => {
      if (!context.sessionId || !context.stateRoot) {
        return "CtxInspect requires an active session.";
      }
      const dbPath = path.join(context.stateRoot, "sessions.sqlite");
      const { existsSync } = await import("node:fs");
      if (!existsSync(dbPath)) return "No session database yet.";
      const mod = await import("../session-store.js");
      const store = new mod.SessionStore(dbPath);
      try {
        const session = store.getSession(context.sessionId);
        if (!session) return `Session not found: ${context.sessionId}`;
        let totalChars = 0;
        const counts: Record<string, number> = { user: 0, assistant: 0, tool: 0, system: 0 };
        for (const m of session.messages) {
          totalChars += m.content.length;
          counts[m.role] = (counts[m.role] ?? 0) + 1;
        }
        const tokens = Math.ceil(totalChars / 4);
        const lines = [
          `Session: ${session.id}`,
          `Title: ${session.title ?? "(untitled)"}`,
          `Messages: ${session.messages.length}`,
          `  user=${counts.user ?? 0}  assistant=${counts.assistant ?? 0}  tool=${counts.tool ?? 0}  system=${counts.system ?? 0}`,
          `Approx tokens: ~${tokens.toLocaleString()} (chars/4 estimate)`,
          ""
        ];
        const recent = session.messages.slice(-5);
        if (recent.length > 0) {
          lines.push("Most recent:");
          for (const m of recent) {
            const preview = m.content.replace(/\s+/g, " ").trim().slice(0, 80);
            lines.push(`  [${m.role}] ${preview}${m.content.length > 80 ? "..." : ""}`);
          }
        }
        if (tokens > 100_000) {
          lines.push("");
          lines.push("Context is large. Consider /compact to summarize older messages.");
        }
        return lines.join("\n");
      } finally {
        store.close();
      }
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true
  },
  {
    name: "VerifyPlanExecution",
    description: "Run the project's build and test commands and return a PASS/FAIL/PARTIAL verdict with evidence. Use after implementation work that touches multiple files. Detects npm/pnpm/yarn, cargo, go, mvn/gradle automatically.",
    category: "verification",
    tags: ["verify", "test", "build"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        skipTests: { type: "boolean", description: "Skip test step (build only). Default false." },
        skipLint: { type: "boolean", description: "Skip lint step. Default false." }
      }
    },
    call: async (input, context) => {
      const { spawnSync } = await import("node:child_process");
      const { existsSync } = await import("node:fs");
      const cwd = context.cwd;
      const opts = input as Record<string, unknown>;
      const skipTests = opts.skipTests === true;
      const skipLint = opts.skipLint === true;

      function detectStack(): { build: string[]; test: string[]; lint?: string[] } | undefined {
        if (existsSync(path.join(cwd, "package.json"))) {
          const pm = existsSync(path.join(cwd, "pnpm-lock.yaml")) ? "pnpm"
                  : existsSync(path.join(cwd, "yarn.lock")) ? "yarn"
                  : "npm";
          return {
            build: [pm, "run", "build"],
            test: [pm, "test", "--", "--run"],
            lint: [pm, "run", "lint"]
          };
        }
        if (existsSync(path.join(cwd, "Cargo.toml"))) return { build: ["cargo", "build"], test: ["cargo", "test"], lint: ["cargo", "clippy"] };
        if (existsSync(path.join(cwd, "go.mod"))) return { build: ["go", "build", "./..."], test: ["go", "test", "./..."], lint: ["go", "vet", "./..."] };
        if (existsSync(path.join(cwd, "pom.xml"))) return { build: ["mvn", "compile"], test: ["mvn", "test"] };
        return undefined;
      }

      const stack = detectStack();
      if (!stack) {
        return [
          "VERDICT: PARTIAL",
          "EVIDENCE: no build system detected",
          `  Looked in: ${cwd}`,
          `  Did not find: package.json, Cargo.toml, go.mod, pom.xml`,
          "Run the relevant build/test commands manually to verify."
        ].join("\n");
      }

      function run(label: string, argv: string[]): { ok: boolean; output: string } {
        const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", env: { ...process.env, CI: "1" }, timeout: 5 * 60 * 1000 });
        const stdout = (r.stdout ?? "").toString();
        const stderr = (r.stderr ?? "").toString();
        const tail = (stdout + stderr).split("\n").slice(-15).join("\n");
        return { ok: r.status === 0, output: `${label}: ${argv.join(" ")}\n${tail}` };
      }

      const evidence: string[] = [];
      const issues: string[] = [];
      let allPassed = true;
      let anyRun = false;

      const buildResult = run("BUILD", stack.build);
      anyRun = true;
      evidence.push(buildResult.output);
      if (!buildResult.ok) { allPassed = false; issues.push("build failed"); }

      if (!skipTests) {
        const testResult = run("TEST", stack.test);
        anyRun = true;
        evidence.push(testResult.output);
        if (!testResult.ok) { allPassed = false; issues.push("tests failed"); }
      }

      if (!skipLint && stack.lint) {
        const lintResult = run("LINT", stack.lint);
        anyRun = true;
        evidence.push(lintResult.output);
        if (!lintResult.ok) { allPassed = false; issues.push("lint failed"); }
      }

      const verdict = !anyRun ? "PARTIAL" : allPassed ? "PASS" : "FAIL";
      const lines = [`VERDICT: ${verdict}`, "", "EVIDENCE:"];
      for (const e of evidence) {
        lines.push("---");
        lines.push(e);
      }
      if (issues.length > 0) {
        lines.push("");
        lines.push("ISSUES:");
        for (const i of issues) lines.push(`  - ${i}`);
      }
      return lines.join("\n");
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false
  }
];

function matchRules(toolUse: MagiToolUsePart, rules: ToolPermissionRules | undefined): ToolPermissionResult | undefined {
  for (const [decision, list] of [
    ["deny", rules?.deny ?? []],
    ["ask", rules?.ask ?? []],
    ["allow", rules?.allow ?? []]
  ] as const) {
    const rule = list.find((item) => ruleMatches(item, toolUse));
    if (rule) {
      return { decision, reason: `matched rule ${rule}` };
    }
  }
  return undefined;
}

function ruleMatches(rule: string, toolUse: MagiToolUsePart): boolean {
  const parsed = /^([A-Za-z0-9_]+)\((.*)\)$/.exec(rule.trim());
  if (!parsed || parsed[1] !== toolUse.name) {
    return false;
  }
  const selector = parsed[2];
  if (selector === "*") {
    return true;
  }
  const haystack = String(
    toolUse.input.command
    ?? toolUse.input.file_path
    ?? toolUse.input.pattern
    ?? toolUse.input.url
    ?? ""
  );
  return globPattern(selector, haystack);
}

function globPattern(pattern: string, value: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(value);
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[]
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function errorResult(toolUse: MagiToolUsePart, content: string, permission?: ToolPermissionResult): RegisteredToolResult {
  return { toolCallId: toolUse.id, toolName: toolUse.name, content, isError: true, permission };
}

function readString(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string") {
    throw new Error(`Tool input ${name} must be a string`);
  }
  return value;
}

function readOptionalString(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Tool input ${name} must be a string`);
  return value;
}

function readOptionalNumber(input: Record<string, unknown>, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Tool input ${name} must be a number`);
  }
  return value;
}

function readOptionalBoolean(input: Record<string, unknown>, name: string): boolean | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Tool input ${name} must be a boolean`);
  return value;
}

function readStringArray(input: Record<string, unknown>, name: string): string[] {
  const value = input[name];
  if (!Array.isArray(value)) {
    throw new Error(`Tool input ${name} must be an array`);
  }
  if (value.length < 1 || value.length > 100) {
    throw new Error(`Tool input ${name} must contain 1 to 100 strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`Tool input ${name}.${index} must be a string`);
    }
    return item;
  });
}

function readGitUntracked(input: Record<string, unknown>, name: string): "all" | "normal" | "none" | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (value === "all" || value === "normal" || value === "none") {
    return value;
  }
  throw new Error(`Tool input ${name} must be all, normal, or none`);
}

function readGitStageMode(input: Record<string, unknown>, name: string): "stage" | "unstage" | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (value === "stage" || value === "unstage") {
    return value;
  }
  throw new Error(`Tool input ${name} must be stage or unstage`);
}

function readOutputMode(input: Record<string, unknown>, name: string): "content" | "files_with_matches" | "count" {
  const value = input[name];
  if (value === undefined) return "content";
  if (value === "content" || value === "files_with_matches" || value === "count") {
    return value;
  }
  throw new Error(`Tool input ${name} must be content, files_with_matches, or count`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function requireStateFile(context: ToolExecutionContext): string {
  if (!context.stateRoot) {
    throw new Error("Cron tools require Magi stateRoot");
  }
  return cronStorePathFromRoot(context.stateRoot);
}

function requireTodoContext(context: ToolExecutionContext): { stateRoot: string; sessionId: string } {
  if (!context.stateRoot) {
    throw new Error("TodoWrite requires Magi stateRoot");
  }
  if (!context.sessionId) {
    throw new Error("TodoWrite requires a Magi sessionId");
  }
  return {
    stateRoot: context.stateRoot,
    sessionId: context.sessionId
  };
}

function requireConfigFile(context: ToolExecutionContext): string {
  if (!context.stateRoot) {
    throw new Error("Config requires Magi stateRoot");
  }
  return path.join(path.dirname(context.stateRoot), "config.yaml");
}

function requireSkillsRoot(context: ToolExecutionContext): string {
  if (!context.stateRoot) {
    throw new Error("Skill requires Magi stateRoot");
  }
  return path.join(path.dirname(context.stateRoot), "skills");
}

function isValidMemdirType(value: string): value is MemdirType {
  return value === "user" || value === "feedback" || value === "project" || value === "reference";
}
