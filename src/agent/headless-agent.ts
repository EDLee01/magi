import { LocalAction, parseLocalPlan } from "./local-plan.js";
import { SessionStore } from "../session-store.js";
import { readWorkspaceFile, writeWorkspaceFile } from "../tools/files.js";
import { getGitSummary } from "../tools/git.js";
import { searchWorkspace } from "../tools/search.js";
import { runShellCommand } from "../tools/shell.js";

export interface LocalAgentResult {
  handled: boolean;
  output?: string;
  actions?: LocalAction[];
}

export async function runLocalHeadlessAgent(input: {
  prompt: string;
  cwd: string;
  sessionId: string;
  jobId: string;
  store: SessionStore;
  env?: NodeJS.ProcessEnv;
}): Promise<LocalAgentResult> {
  const plan = parseLocalPlan(input.prompt);
  if (!plan) {
    return { handled: false };
  }

  const observations: string[] = [];
  input.store.recordAudit({
    sessionId: input.sessionId,
    jobId: input.jobId,
    action: "agent.plan.created",
    target: "local-headless",
    metadata: { actions: plan.actions }
  });

  for (const action of plan.actions) {
    observations.push(await runAction({ ...input, action }));
  }

  return {
    handled: true,
    output: observations.join("\n"),
    actions: plan.actions
  };
}

async function runAction(input: {
  action: LocalAction;
  prompt: string;
  cwd: string;
  sessionId: string;
  jobId: string;
  store: SessionStore;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  if (input.action.type === "read-file") {
    const result = readWorkspaceFile({ cwd: input.cwd, filePath: input.action.filePath });
    input.store.recordAudit({
      sessionId: input.sessionId,
      jobId: input.jobId,
      action: "tool.file.read",
      target: result.path,
      metadata: { sizeBytes: result.sizeBytes }
    });
    return `Read ${result.path} (${result.sizeBytes} bytes)\n${result.content}`;
  }

  if (input.action.type === "write-file") {
    const result = writeWorkspaceFile({
      cwd: input.cwd,
      filePath: input.action.filePath,
      content: input.action.content,
      approved: true
    });
    input.store.recordAudit({
      sessionId: input.sessionId,
      jobId: input.jobId,
      action: "tool.file.write.approved",
      target: result.path,
      metadata: { diff: result.diff, approved: result.approved }
    });
    return `Wrote ${result.path}\n${result.diff}`;
  }

  if (input.action.type === "search") {
    const matches = searchWorkspace({ cwd: input.cwd, query: input.action.query });
    input.store.recordAudit({
      sessionId: input.sessionId,
      jobId: input.jobId,
      action: "tool.search",
      target: input.action.query,
      metadata: { matches: matches.length }
    });
    return matches.length === 0
      ? `No matches for ${JSON.stringify(input.action.query)}`
      : matches.map((match) => `${match.path}:${match.line}:${match.text}`).join("\n");
  }

  if (input.action.type === "shell") {
    const result = await runShellCommand({
      cwd: input.cwd,
      command: input.action.command,
      approveDangerous: input.env?.MAGI_APPROVE_DANGEROUS_COMMANDS === "1"
    });
    input.store.recordAudit({
      sessionId: input.sessionId,
      jobId: input.jobId,
      action: "tool.shell.run",
      target: input.action.command,
      metadata: { exitCode: result.exitCode, timedOut: result.timedOut }
    });
    return [
      `Command exited ${result.exitCode}`,
      result.stdout ? `stdout:\n${result.stdout.trimEnd()}` : undefined,
      result.stderr ? `stderr:\n${result.stderr.trimEnd()}` : undefined
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  const git = getGitSummary(input.cwd);
  input.store.recordAudit({
    sessionId: input.sessionId,
    jobId: input.jobId,
    action: "tool.git.summary",
    target: input.cwd,
    metadata: { ...git }
  });
  if (!git.gitAvailable || !git.isRepository) {
    return git.reason ?? "Git summary is unavailable";
  }
  return [
    `branch: ${git.branch}`,
    git.status ? `status:\n${git.status}` : "status: clean",
    git.diffStat ? `diffStat:\n${git.diffStat}` : "diffStat: none"
  ].join("\n");
}
