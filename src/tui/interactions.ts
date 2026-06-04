/**
 * TUI interaction handlers — approval prompts, question prompts, and
 * dispatch for pending audit events that need user input.
 *
 * The functions here are async I/O glue: they read from a readline-shaped
 * `rl.question(...)` input and write prompts to a Writable. They convert
 * pending events from the audit log into resolutions on the
 * ActiveInteractionRegistry.
 */

import { Interface as ReadlinePromisesInterface } from "node:readline/promises";
import { Readable, Writable } from "node:stream";

import { MagiEventView } from "../events.js";
import { ActiveInteractionRegistry } from "../interactions.js";
import { addPermissionRule, isToolAlwaysAllowed } from "../permissions.js";
import { showTuiPicker } from "./picker.js";
import {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  formatAskUserQuestionForTerminal,
  normalizeAskUserQuestionAnswer,
  parseAskUserQuestionSelection,
  UserQuestionResolver
} from "../tools/user-question.js";

export function createTerminalUserQuestionResolver(
  rl: Pick<ReadlinePromisesInterface, "question">,
  terminalOutput: Pick<Writable, "write">,
  signal?: AbortSignal
): UserQuestionResolver {
  return async ({ question }) => {
    const answers: AskUserQuestionAnswer["answers"] = [];
    for (let index = 0; index < question.questions.length; index += 1) {
      const item = question.questions[index];
      while (true) {
        terminalOutput.write(`${formatAskUserQuestionForTerminal(question, index)}\n`);
        const raw = await askReadlineQuestion(rl, "? ", signal);
        try {
          const selectedOptions = parseAskUserQuestionSelection(raw, item);
          answers.push({
            question: item.question,
            selectedLabels: selectedOptions.map((option) => option.label),
            selectedOptions
          });
          break;
        } catch (error) {
          terminalOutput.write(`${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
    return { answers };
  };
}

export async function handleTuiPendingInteraction(input: {
  event: MagiEventView;
  interactions: ActiveInteractionRegistry;
  rl: Pick<ReadlinePromisesInterface, "question">;
  stdin?: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void; isRaw?: boolean };
  output: Pick<Writable, "write">;
  handled: Set<string>;
  signal?: AbortSignal;
}): Promise<void> {
  if (input.event.status !== "pending") {
    return;
  }
  const kind = readString(input.event.metadata.interactionKind);
  const toolUseId = readString(input.event.metadata.toolUseId);
  if (!input.event.jobId || !toolUseId || (kind !== "approval" && kind !== "question")) {
    return;
  }
  const key = `${input.event.jobId}\0${kind}\0${toolUseId}`;
  if (input.handled.has(key)) {
    return;
  }
  input.handled.add(key);

  try {
    if (kind === "approval") {
      const toolName = input.event.target ?? "unknown";
      // Check persistent permission rules
      if (toolName !== "Bash" && isToolAlwaysAllowed(toolName)) {
        input.interactions.resolveApproval({
          jobId: input.event.jobId,
          toolUseId,
          approved: true
        });
        return;
      }
      const approved = await askTerminalApproval({
        event: input.event,
        rl: input.rl,
        stdin: input.stdin,
        output: input.output,
        signal: input.signal
      });
      input.interactions.resolveApproval({
        jobId: input.event.jobId,
        toolUseId,
        approved
      });
      return;
    }

    const question = readQuestionMetadata(input.event.metadata.question);
    if (!question) {
      input.output.write(
        "[question] pending event is missing question metadata; waiting for external control response\n"
      );
      return;
    }
    const answer = await askTerminalQuestion({
      question,
      rl: input.rl,
      output: input.output,
      signal: input.signal
    });
    input.interactions.resolveQuestion({
      jobId: input.event.jobId,
      toolUseId,
      answer
    });
  } catch (error) {
    if (isAbortError(error) || input.signal?.aborted) {
      try {
        input.interactions.cancelInteraction({
          jobId: input.event.jobId,
          toolUseId,
          reason: "request aborted"
        });
      } catch {
        // The interaction may already have been resolved by another control path.
      }
      return;
    }
    input.output.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function askTerminalApproval(input: {
  event: MagiEventView;
  rl: Pick<ReadlinePromisesInterface, "question">;
  stdin?: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void; isRaw?: boolean };
  output: Pick<Writable, "write">;
  signal?: AbortSignal;
}): Promise<boolean> {
  const toolUseId = readString(input.event.metadata.toolUseId) ?? "unknown";
  const toolName = input.event.target ?? "unknown";
  const reason = readString(input.event.metadata.reason);
  const diff = readString(input.event.metadata.diff);
  const toolUse = readRecord(input.event.metadata.toolUse);
  const toolInput = readRecord(toolUse?.input);
  const command = toolName === "Bash" ? readString(toolInput?.command) : undefined;
  const timeoutMs = toolName === "Bash" ? readNumber(toolInput?.timeout_ms) : undefined;
  const cwd =
    toolName === "Bash" ? (readString(input.event.metadata.cwd) ?? process.cwd()) : undefined;
  const allowAlways = toolName !== "Bash";
  const lines: string[] = [
    "Approval required",
    `tool: ${toolName}`,
    `toolUseId: ${toolUseId}`,
    command ? `command: ${command}` : undefined,
    cwd ? `cwd: ${cwd}` : undefined,
    timeoutMs !== undefined ? `timeout_ms: ${timeoutMs}` : undefined,
    reason ? `reason: ${reason}` : undefined
  ].filter((line): line is string => Boolean(line));

  if (diff) {
    lines.push("", "Diff preview:");
    lines.push(
      ...diff
        .split("\n")
        .slice(0, 80)
        .map((line) => colorizeDiffLine(line))
    );
    if (diff.split("\n").length > 80) {
      lines.push(`\x1b[90m... ${diff.split("\n").length - 80} more lines\x1b[39m`);
    }
  }

  if (input.stdin?.isTTY && input.stdin.setRawMode) {
    input.output.write(lines.join("\n") + "\n");
    const decision = await showTuiPicker({
      stdin: input.stdin,
      stdout: input.output,
      title: "approval required",
      items: [
        { label: "Allow", value: "allow", description: `Run ${toolName}` },
        { label: "Deny", value: "deny", description: "Reject this tool call" },
        ...(allowAlways
          ? [
              {
                label: "Always allow",
                value: "always",
                description: `Persistently allow ${toolName}`
              }
            ]
          : [])
      ],
      emptyMessage: "No matching approval actions",
      footer: allowAlways
        ? "↑↓ select · y allow · n deny · a always · Enter choose · Esc deny"
        : "↑↓ select · y allow · n deny · Enter choose · Esc deny",
      maxVisibleItems: allowAlways ? 3 : 2,
      hotkeys: {
        y: "allow",
        Y: "allow",
        n: "deny",
        N: "deny",
        ...(allowAlways ? { a: "always", A: "always" } : {})
      },
      cancelValue: "deny",
      signal: input.signal
    });
    if (decision === "always") {
      addPermissionRule(toolName, `Always allow ${toolName}`);
      input.output.write(`\x1b[32m✓ Added persistent rule: always allow "${toolName}"\x1b[39m\n`);
      return true;
    }
    return decision === "allow";
  }

  lines.push(
    "",
    allowAlways ? "Choose: [y]es / [n]o / [a]lways allow this tool" : "Choose: [y]es / [n]o"
  );
  input.output.write(lines.join("\n") + "\n");

  while (true) {
    const raw = (
      await askReadlineQuestion(
        input.rl,
        allowAlways ? "approve? [y/n/a] " : "approve? [y/n] ",
        input.signal
      )
    )
      .trim()
      .toLowerCase();
    if (
      raw === "y" ||
      raw === "yes" ||
      raw === "approve" ||
      raw === "approved" ||
      raw === "allow"
    ) {
      return true;
    }
    if (raw === "n" || raw === "no" || raw === "deny" || raw === "denied" || raw === "reject") {
      return false;
    }
    if (allowAlways && (raw === "a" || raw === "always")) {
      addPermissionRule(toolName, `Always allow ${toolName}`);
      input.output.write(`\x1b[32m✓ Added persistent rule: always allow "${toolName}"\x1b[39m\n`);
      return true;
    }
    input.output.write(
      allowAlways ? "Enter y/yes, n/no, or a/always.\n" : "Enter y/yes or n/no.\n"
    );
  }
}

export function colorizeDiffLine(line: string): string {
  if (line.startsWith("---") || line.startsWith("+++")) {
    return `\x1b[36m${line}\x1b[39m`; // cyan
  }
  if (line.startsWith("@@")) {
    return `\x1b[90m${line}\x1b[39m`; // gray
  }
  if (line.startsWith("+")) {
    return `\x1b[32m${line}\x1b[39m`; // green
  }
  if (line.startsWith("-")) {
    return `\x1b[31m${line}\x1b[39m`; // red
  }
  return line;
}

async function askTerminalQuestion(input: {
  question: AskUserQuestionRequest;
  rl: Pick<ReadlinePromisesInterface, "question">;
  output: Pick<Writable, "write">;
  signal?: AbortSignal;
}): Promise<AskUserQuestionAnswer> {
  const resolver = createTerminalUserQuestionResolver(input.rl, input.output, input.signal);
  return normalizeAskUserQuestionAnswer(
    input.question,
    await resolver({
      toolUse: {
        type: "tool-use",
        id: "AskUserQuestion",
        name: "AskUserQuestion",
        input: {}
      },
      question: input.question
    })
  );
}

async function askReadlineQuestion(
  rl: Pick<ReadlinePromisesInterface, "question">,
  query: string,
  signal?: AbortSignal
): Promise<string> {
  if (signal) {
    return rl.question(query, { signal });
  }
  return rl.question(query);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function readQuestionMetadata(value: unknown): AskUserQuestionRequest | undefined {
  if (!isRecord(value) || !Array.isArray(value.questions)) {
    return undefined;
  }
  const questions = value.questions.map((rawQuestion) => {
    if (
      !isRecord(rawQuestion) ||
      typeof rawQuestion.question !== "string" ||
      !Array.isArray(rawQuestion.options)
    ) {
      return undefined;
    }
    const options = rawQuestion.options.map((rawOption) => {
      if (
        !isRecord(rawOption) ||
        typeof rawOption.label !== "string" ||
        typeof rawOption.description !== "string"
      ) {
        return undefined;
      }
      return {
        label: rawOption.label,
        description: rawOption.description,
        preview: typeof rawOption.preview === "string" ? rawOption.preview : undefined
      };
    });
    if (options.some((option) => option === undefined)) {
      return undefined;
    }
    return {
      question: rawQuestion.question,
      header: typeof rawQuestion.header === "string" ? rawQuestion.header : undefined,
      preview: typeof rawQuestion.preview === "string" ? rawQuestion.preview : undefined,
      options: options as AskUserQuestionRequest["questions"][number]["options"],
      multiSelect:
        typeof rawQuestion.multiSelect === "boolean" ? rawQuestion.multiSelect : undefined
    };
  });
  if (questions.some((question) => question === undefined)) {
    return undefined;
  }
  return { questions: questions as AskUserQuestionRequest["questions"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseTuiInteractionTimeoutMs(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
