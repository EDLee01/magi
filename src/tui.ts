import { Interface as ReadlinePromisesInterface } from "node:readline/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";

import { AgentQueryEvent } from "./agent/query.js";
import { MagiConfig } from "./config.js";
import { formatEventList, MagiEventView, toEventView } from "./events.js";
import {
  buildTuiTranscriptState,
  formatTuiLiveEvent,
  formatTuiTranscriptEntry,
  formatTuiTranscriptStatus,
  TuiTranscriptEntry,
  TuiTranscriptState
} from "./tui/transcript.js";
import { installPasteHandler } from "./tui/paste.js";
import {
  colorizeDiffLine,
  createTerminalUserQuestionResolver,
  handleTuiPendingInteraction,
  parseTuiInteractionTimeoutMs
} from "./tui/interactions.js";
import { runHeadlessPrompt } from "./headless.js";
import { ActiveInteractionRegistry } from "./interactions.js";
import { MagiPaths } from "./paths.js";
import { resolveModelPickerSelection, resolveSessionPickerSelection } from "./slash.js";
import { parseCommandLine, registry } from "./commands/registry.js";
import { isVimModeEnabled } from "./commands/vim.js";
import { readLineWithVim } from "./vim/lineEditor.js";
import { startSpinner } from "./spinner.js";
import { createStreamingMarkdown } from "./markdown.js";
import { isToolAlwaysAllowed, addPermissionRule } from "./permissions.js";
import { loadHistory, appendHistory, decodeHistoryEntry } from "./history.js";
import { showSlashMenu } from "./slash-menu.js";
import { takePendingImages } from "./commands/image.js";
import { encodePromptWithImages } from "./providers/ir.js";
import { findSkill, listSkills } from "./skills/loader.js";
import { getProactiveSuggestions, isProactiveEnabled, setProactiveEnabled } from "./proactive.js";
import { SessionStore } from "./session-store.js";
import { getBuiltinToolDefinitions } from "./tools/registry.js";
import {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  formatAskUserQuestionForTerminal,
  normalizeAskUserQuestionAnswer,
  parseAskUserQuestionSelection,
  UserQuestionResolver
} from "./tools/user-question.js";

export const MAGI_TEXT_HAT = [
  "  △",
  " /✦\\",
  "▔▔▔"
].join("\n");

export interface TuiLiveEventWriter {
  stop: () => void;
  getSessionId: () => string | undefined;
}

export type { TuiTranscriptEntry, TuiTranscriptState } from "./tui/transcript.js";
export { buildTuiTranscriptState, formatTuiLiveEvent, formatTuiTranscriptEntry, formatTuiTranscriptStatus } from "./tui/transcript.js";
export { colorizeDiffLine, createTerminalUserQuestionResolver } from "./tui/interactions.js";

export async function runInteractiveTerminal(inputConfig: {
  cwd: string;
  config: MagiConfig;
  store: SessionStore;
  paths?: MagiPaths;
  env?: NodeJS.ProcessEnv;
  modelAlias?: string;
  sessionId?: string;
}): Promise<number> {
  if (!input.isTTY || !output.isTTY) {
    output.write("Interactive terminal requires a TTY. Use magi -p <prompt> for headless mode.\n");
    return 2;
  }

  const rl = readline.createInterface({
    input,
    output,
    completer: (line: string): [string[], string] => {
      const match = line.match(/^\/(\w*)$/);
      if (!match) {
        return [[], line];
      }
      const partial = match[1].toLowerCase();
      const all = registry.getAll();
      const matches = partial
        ? all.filter(cmd => cmd.name.startsWith(partial) || (cmd.aliases ?? []).some(a => a.startsWith(partial)))
        : all;
      if (matches.length === 0) {
        return [[], line];
      }
      // If single match, complete it directly
      if (matches.length === 1) {
        return [[`/${matches[0].name} `], line];
      }
      // Show all matches with descriptions
      const maxName = Math.max(...matches.map(c => c.name.length));
      const display = matches.map(cmd => `/${cmd.name.padEnd(maxName)}  ${cmd.description}`);
      // Print the menu above the prompt
      output.write("\n" + display.join("\n") + "\n");
      return [[`/${partial}`], line];
    }
  });
  let currentModel = inputConfig.modelAlias ?? "main";
  let currentSessionId = inputConfig.sessionId;
  let running = false;
  const modelDisplay = inputConfig.config.models.aliases[currentModel] ?? currentModel;
  const toolCount = getBuiltinToolDefinitions().length;
  output.write([
    "",
    `\x1b[36m  △\x1b[39m   \x1b[1mMagi\x1b[22m \x1b[90m· ${toolCount} tools\x1b[39m`,
    `\x1b[36m /✦\\\x1b[39m  \x1b[90mcwd:\x1b[39m ${inputConfig.cwd}`,
    `\x1b[36m▔▔▔\x1b[39m   \x1b[90mmodel:\x1b[39m ${modelDisplay}`,
    "",
    "  \x1b[90m/help for commands · Ctrl+C to interrupt · /exit to quit\x1b[39m",
    ""
  ].join("\n"));
  // Show a setup hint if no provider is configured
  const aliasCount = Object.keys(inputConfig.config.models?.aliases ?? {}).length;
  const providerCount = Object.keys(inputConfig.config.providers ?? {}).length;
  if (providerCount === 0 || aliasCount === 0) {
    output.write([
      "\x1b[33m  ⚠ No provider is configured.\x1b[39m",
      "    \x1b[90mRun 'magi init' (in another shell) to set up a provider, then restart.\x1b[39m",
      ""
    ].join("\n"));
  }
  // Handle Ctrl+C: interrupt running query or exit on double-Ctrl+C.
  // readline emits 'SIGINT' on the rl instance (not on stdin); attaching here
  // also suppresses readline's default behavior of killing the process.
  let lastSigintAt = 0;
  const onSigint = () => {
    if (!running) {
      // Double Ctrl+C within 1 second exits the program
      const now = Date.now();
      if (now - lastSigintAt < 1000) {
        output.write("\n");
        rl.close();
        process.exit(0);
      }
      lastSigintAt = now;
      output.write("\n\x1b[90mPress Ctrl+C again to exit\x1b[39m\n");
      rl.prompt(true);
      return;
    }
    output.write("\n\x1b[33mInterrupting...\x1b[39m\n");
  };
  rl.on("SIGINT", onSigint);
  const inputHistory: string[] = loadHistory().map(decodeHistoryEntry);

  // Bracketed paste handling — see src/tui/paste.ts.
  const paste = installPasteHandler({ rl, stdin: input, stdout: output });

  try {
    while (true) {
      let line: string;
      if (isVimModeEnabled()) {
        // Vim mode: use raw-mode line editor
        rl.pause();
        try {
          line = await readLineWithVim({
            input,
            output,
            prompt: "> ",
            history: inputHistory
          });
        } catch (err) {
          if ((err as Error).message === "SIGINT" || (err as Error).message === "EOF") {
            return 0;
          }
          throw err;
        }
        rl.resume();
      } else {
        line = await rl.question("> ");
      }
      // Substitute paste placeholders back to real content before processing
      line = paste.restorePastes(line);
      let trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      // Multi-line input: backslash continuation or unclosed code fences
      if (trimmed.endsWith("\\") || hasUnclosedFence(trimmed)) {
        const multiLines: string[] = [trimmed.endsWith("\\") ? trimmed.slice(0, -1) : trimmed];
        while (true) {
          const cont = await rl.question("\x1b[90m... \x1b[39m");
          if (cont.trim() === "" && !hasUnclosedFence(multiLines.join("\n"))) {
            break; // Empty line ends multi-line (unless inside code fence)
          }
          if (cont.trim().endsWith("\\")) {
            multiLines.push(cont.trim().slice(0, -1));
          } else {
            multiLines.push(cont);
            if (!hasUnclosedFence(multiLines.join("\n"))) {
              break;
            }
          }
        }
        trimmed = multiLines.join("\n").trim();
      }

      if (!trimmed) {
        continue;
      }

      // Paste detection: show summary for any multi-line or long input
      const lineCount = trimmed.split("\n").length;
      const charCount = trimmed.length;
      if (lineCount >= 2 || charCount > 500) {
        output.write(`\x1b[90m[pasted ${charCount} chars, ${lineCount} lines]\x1b[39m\n`);
      }

      if (trimmed) {
        inputHistory.push(trimmed);
        appendHistory(trimmed);
      }
      if (trimmed === "/exit" || trimmed === "/quit") {
        return 0;
      }

      const parsed = parseCommandLine(trimmed);
      if (parsed) {
        // Bare "/" — show interactive slash menu
        if (parsed.name === "") {
          rl.pause();
          // Detach readline's data listener so it doesn't consume menu keystrokes
          const rlDataListeners = input.rawListeners("data").slice();
          input.removeAllListeners("data");
          input.resume();
          const skillItems = inputConfig.paths
            ? listSkills(inputConfig.paths).map(s => ({ name: s.name, description: `[skill] ${s.summary}` }))
            : [];
          const picked = await showSlashMenu({
            stdin: input,
            stdout: output,
            items: [
              ...registry.getAll().map(cmd => ({ name: cmd.name, description: cmd.description })),
              ...skillItems,
              { name: "exit", description: "Quit Magi" },
              { name: "continue", description: "Continue last response" }
            ]
          });
          output.write("\x1b[?25h"); // show cursor
          // Restore readline's data listeners
          for (const listener of rlDataListeners) {
            input.on("data", listener as (...args: unknown[]) => void);
          }
          if (picked) {
            trimmed = picked.trim();
            // Re-parse the picked command
            const reparsed = parseCommandLine(trimmed);
            if (reparsed) {
              if (trimmed === "/exit" || trimmed === "/quit") {
                return 0;
              }
              // Fall through to dispatch below with reparsed
              Object.assign(parsed, reparsed);
            }
          } else {
            rl.resume();
            continue;
          }
          rl.resume();
        }

        if (parsed.name === "help") {
          const result = await registry.dispatch("help", parsed.args, {
            cwd: inputConfig.cwd,
            config: inputConfig.config,
            store: inputConfig.store,
            paths: inputConfig.paths,
            sessionId: currentSessionId,
            currentModel
          });
          if (result) {
            output.write(result + "\n");
            output.write("  /exit or /quit            Quit Magi Next\n");
            output.write("  /continue                 Ask the model to continue its last response\n");
          }
          continue;
        }

        // State-updating commands
        if (parsed.name === "model" && parsed.args[0]) {
          const selected = resolveModelPickerSelection(inputConfig.config, parsed.args[0]);
          if (selected) currentModel = selected;
        }
        if (parsed.name === "resume" && parsed.args[0]) {
          const selected = resolveSessionPickerSelection(inputConfig.store, parsed.args[0]);
          if (selected) {
            currentSessionId = selected.id;
            output.write(formatSessionResume(inputConfig.store, selected.id) + "\n");
          }
        }
        if (parsed.name === "clear") {
          currentSessionId = inputConfig.store.createSession({
            title: "",
            cwd: inputConfig.cwd,
            metadata: { mode: "interactive", clearedFrom: currentSessionId }
          });
        }

        const result = await registry.dispatch(parsed.name, parsed.args, {
          cwd: inputConfig.cwd,
          config: inputConfig.config,
          store: inputConfig.store,
          paths: inputConfig.paths,
          sessionId: currentSessionId,
          currentModel
        });
        if (result !== undefined) {
          output.write(`${result}\n`);
          continue;
        }
        // Check if this is a user-installed skill (e.g., /commit, /review-pr)
        if (inputConfig.paths) {
          const skill = findSkill(inputConfig.paths, parsed.name);
          if (skill) {
            // Inject skill body as the prompt; let the model handle it
            const skillArgs = parsed.args.length > 0 ? `\n\nArguments: ${parsed.args.join(" ")}` : "";
            trimmed = `Execute the "${skill.name}" skill:\n\n${skill.body ?? ""}${skillArgs}`;
            // Fall through to normal prompt flow
          } else {
            // /continue: fall through to normal prompt flow with "continue"
            if (parsed.name !== "continue") {
              output.write(formatUnknownCommand(parsed.name));
              continue;
            }
            if (!currentSessionId) {
              output.write("No active session to continue. Start a conversation first.\n");
              continue;
            }
            trimmed = "continue";
          }
        } else {
          // /continue: fall through to normal prompt flow with "continue"
          if (parsed.name !== "continue") {
            output.write(formatUnknownCommand(parsed.name));
            continue;
          }
          if (!currentSessionId) {
            output.write("No active session to continue. Start a conversation first.\n");
            continue;
          }
          trimmed = "continue";
        }
      }

      currentSessionId ??= inputConfig.store.createSession({
        title: trimmed.slice(0, 80),
        cwd: inputConfig.cwd,
        metadata: { mode: "interactive" }
      });
      const activeInteractions = new ActiveInteractionRegistry({
        timeoutMs: parseTuiInteractionTimeoutMs(inputConfig.env?.MAGI_INTERACTION_TIMEOUT_MS)
      });
      const liveEvents = startTuiLiveEventWriter({
        store: inputConfig.store,
        output,
        sessionId: currentSessionId,
        interactions: activeInteractions,
        rl
      });
      running = true;
      const startedAt = Date.now();
      let streamedAny = false;
      const usedTools = new Set<string>();
      let hadErrors = false;
      let lastEventText = "";
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      const modelDisplayInline = inputConfig.config.models?.aliases?.[currentModel] ?? currentModel;
      const spinner = startSpinner(output, { model: modelDisplayInline });
      const md = createStreamingMarkdown();
      // Attach any images queued by /image. encodePromptWithImages adds a
      // sentinel-prefixed block that the agent loop parses back into multi-part
      // user messages.
      const pendingImages = takePendingImages();
      const promptWithImages = pendingImages.length > 0
        ? encodePromptWithImages(trimmed, pendingImages)
        : trimmed;
      if (pendingImages.length > 0) {
        output.write(`\x1b[90m[attaching ${pendingImages.length} image${pendingImages.length === 1 ? "" : "s"}]\x1b[39m\n`);
      }
      let result: Awaited<ReturnType<typeof runHeadlessPrompt>> | undefined;
      try {
        result = await runHeadlessPrompt({
          prompt: promptWithImages,
          cwd: inputConfig.cwd,
          store: inputConfig.store,
          config: inputConfig.config,
          env: inputConfig.env,
          paths: inputConfig.paths,
          stateRoot: inputConfig.paths?.stateRoot,
          modelAlias: currentModel,
          sessionId: currentSessionId,
          activeInteractions,
          permissionMode: "default",
          onStreamEvent: (event: AgentQueryEvent) => {
            if (event.type === "text_delta") {
              if (!streamedAny) spinner.stop();
              streamedAny = true;
              const rendered = md.push(event.text);
              if (rendered) output.write(rendered);
              lastEventText += event.text;
            }
            if (event.type === "tool_use") {
              // Update spinner to show which tool is running, then keep spinning
              spinner.update({ text: `Tool: ${event.toolUse.name}` });
              usedTools.add(event.toolUse.name);
            }
            if (event.type === "tool_result") {
              // Restore "Thinking" once tool finishes
              spinner.update({ text: "Thinking" });
              if (event.isError) hadErrors = true;
            }
            if (event.type === "error") {
              hadErrors = true;
            }
            if (event.type === "usage") {
              totalInputTokens += event.usage.inputTokens;
              totalOutputTokens += event.usage.outputTokens;
              spinner.update({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
            }
            if (event.type === "compact_boundary") {
              if (!streamedAny) spinner.stop();
              output.write(`\x1b[90m[context compacted: ${event.sourceMessageCount} messages, ~${event.estimatedTokensBefore} tokens]\x1b[39m\n`);
            }
          }
        });
      } catch (err) {
        // Provider/agent failure must not kill the TUI session.
        // Stop transient UI, show the error, and return to the prompt.
        spinner.stop();
        const remaining = md.flush();
        if (remaining) output.write(remaining);
        const msg = err instanceof Error ? err.message : String(err);
        output.write(`\n\x1b[31m✗ ${msg}\x1b[39m\n`);
        running = false;
        hadErrors = true;
        continue;
      } finally {
        spinner.stop();
        const remaining = md.flush();
        if (remaining) output.write(remaining);
        liveEvents.stop();
        activeInteractions.close();
      }
      running = false;
      currentSessionId = result.sessionId;
      if (!streamedAny && result.message) {
        output.write(`${result.message}\n`);
      } else if (streamedAny) {
        output.write("\n");
      }
      const elapsed = Date.now() - startedAt;
      const secs = (elapsed / 1000).toFixed(1);
      const tokenInfo = totalInputTokens > 0
        ? ` · ${formatTokens(totalInputTokens)}↑ ${formatTokens(totalOutputTokens)}↓`
        : "";
      output.write(`\n\x1b[90m${result.model ?? currentModel} · ${secs}s${tokenInfo}\x1b[39m\n`);

      // Proactive suggestions
      const suggestions = getProactiveSuggestions({
        toolNames: [...usedTools],
        lastMessage: lastEventText || result.message,
        hadErrors
      });
      if (suggestions.length > 0) {
        output.write(`\x1b[90m${suggestions.map(s => `→ ${s}`).join("  ")}\x1b[39m\n`);
      }
    }
  } finally {
    rl.removeListener("SIGINT", onSigint);
    rl.close();
  }
}

export function startTuiLiveEventWriter(input: {
  store: SessionStore;
  output?: Pick<Writable, "write">;
  sessionId?: string;
  afterEventId?: number;
  interactions?: ActiveInteractionRegistry;
  rl?: Pick<ReadlinePromisesInterface, "question">;
}): TuiLiveEventWriter {
  const terminalOutput = input.output ?? output;
  let liveSessionId = input.sessionId;
  const afterEventId = input.afterEventId ?? 0;
  const handledInteractions = new Set<string>();
  const unsubscribe = input.store.subscribeAuditEvents((event) => {
    if (event.id <= afterEventId) {
      return;
    }
    if (liveSessionId) {
      if (event.sessionId !== liveSessionId) {
        return;
      }
    } else {
      liveSessionId = event.sessionId;
    }
    const line = formatTuiLiveEvent(toEventView(event));
    if (line) {
      terminalOutput.write(`${line}\n`);
    }
    if (input.interactions && input.rl) {
      void handleTuiPendingInteraction({
        event: toEventView(event),
        interactions: input.interactions,
        rl: input.rl,
        output: terminalOutput,
        handled: handledInteractions
      });
    }
  });
  return {
    stop: unsubscribe,
    getSessionId: () => liveSessionId
  };
}



export function formatSessionList(store: SessionStore): string {
  const sessions = store.listSessions(50);
  if (sessions.length === 0) {
    return "No sessions\n";
  }
  return [
    "Recent sessions:",
    ...sessions.map((session, index) => {
      const marker = index === 0 ? ">" : " ";
      return `${marker} ${session.id}  ${session.updatedAt}  ${session.messageCount} msg  ${session.title ?? "(untitled)"}  ${session.cwd}`;
    }),
    "Use magi -r <session-id> -p <prompt> or magi resume <session-id>."
  ].join("\n") + "\n";
}

export function formatSessionResume(store: SessionStore, sessionId: string): string {
  const session = store.getSession(sessionId);
  if (!session) {
    return `Session not found: ${sessionId}\n`;
  }
  const pending = store.listSessionAuditEvents(sessionId, 50)
    .map(toEventView)
    .filter((event) => event.status === "pending" && (event.category === "approval" || event.category === "question"));
  const events = store.listSessionAuditEvents(sessionId, 8).map(toEventView);
  const transcript = buildTuiTranscriptState(store.listSessionAuditEvents(sessionId, 50).map(toEventView), {
    sessionId,
    limit: 8
  });
  return [
    `sessionId: ${session.id}`,
    `title: ${session.title ?? "(untitled)"}`,
    `cwd: ${session.cwd}`,
    `messages: ${session.messages.length}`,
    ...session.messages.map((message) => `${message.role}: ${message.content}`),
    formatPendingResumeInteractions(pending),
    formatTuiTranscriptStatus(transcript),
    formatEventList(events),
    ""
  ].join("\n");
}

function formatPendingResumeInteractions(events: ReturnType<typeof toEventView>[]): string {
  if (events.length === 0) {
    return "Pending interactions: none";
  }
  return [
    "Pending interactions:",
    ...events.map((event) => {
      const toolUseId = typeof event.metadata.toolUseId === "string" ? event.metadata.toolUseId : event.target ?? "unknown";
      return `- ${event.category} ${toolUseId} job=${event.jobId ?? "unknown"} ${event.message}`;
    })
  ].join("\n");
}

/**
 * Detect rapid line submissions (paste).
 * After the initial line resolves, listen for more lines arriving within
 * `windowMs`. As long as new lines keep arriving inside that window, merge
 * them. This handles terminals that wrap pastes as multiple `\n`-separated
 * line events.
 *
 * Exported for testing. The first arg only needs `on`/`off` for the "line"
 * event, so we accept a minimal interface.
 */
export interface LineEmitter {
  on(event: "line", listener: (line: string) => void): unknown;
  off(event: "line", listener: (line: string) => void): unknown;
}

export async function collectPastedContinuations(rl: LineEmitter, firstLine: string, windowMs = 100): Promise<string> {
  const lines: string[] = [firstLine];
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await new Promise<string | undefined>((resolve) => {
      const onLine = (next: string) => {
        if (timer) clearTimeout(timer);
        rl.off("line", onLine);
        resolve(next);
      };
      rl.on("line", onLine);
      timer = setTimeout(() => {
        rl.off("line", onLine);
        resolve(undefined);
      }, windowMs);
    });
    if (next === undefined) break;
    lines.push(next);
  }
  return lines.join("\n");
}

function formatUnknownCommand(name: string): string {
  const suggestion = registry.suggestCommand(name);
  if (suggestion && suggestion !== name) {
    return `\x1b[33mUnknown slash command:\x1b[39m /${name}\n  Did you mean \x1b[36m/${suggestion}\x1b[39m?\n`;
  }
  return `\x1b[33mUnknown slash command:\x1b[39m /${name}\n  Run \x1b[36m/help\x1b[39m to see available commands.\n`;
}

function hasUnclosedFence(text: string): boolean {
  const fences = text.split("\n").filter((l) => l.trimStart().startsWith("```"));
  return fences.length % 2 !== 0;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
