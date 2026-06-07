import { Interface as ReadlinePromisesInterface } from "node:readline/promises";
import readline from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
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
import { readTuiPrompt, TuiPromptAbortError } from "./tui/prompt-reader.js";
import {
  colorizeDiffLine,
  createTerminalUserQuestionResolver,
  handleTuiPendingInteraction,
  parseTuiInteractionTimeoutMs
} from "./tui/interactions.js";
import { runHeadlessPrompt } from "./headless.js";
import { ActiveInteractionRegistry } from "./interactions.js";
import { MagiPaths } from "./paths.js";
import { resolveModelPickerSelection } from "./slash.js";
import { parseCommandLine, registry } from "./commands/registry.js";
import { isVimModeEnabled } from "./commands/vim.js";
import {
  formatPermissionModeLabel,
  formatPermissionModeUpdate,
  parsePermissionMode,
  PERMISSION_MODES
} from "./commands/permissions.js";
import { readLineWithVim } from "./vim/lineEditor.js";
import { startSpinner } from "./spinner.js";
import { createStreamingMarkdown } from "./markdown.js";
import { isToolAlwaysAllowed, addPermissionRule } from "./permissions.js";
import { loadHistory, appendHistory, decodeHistoryEntry } from "./history.js";
import { showSlashMenu } from "./slash-menu.js";
import { showTuiPicker, TuiPickerItem } from "./tui/picker.js";
import { buildTuiRenderState } from "./tui/render-state.js";
import { renderTuiState } from "./tui/renderer.js";
import { takePendingImages } from "./commands/image.js";
import { encodePromptWithImages } from "./providers/ir.js";
import { findSkill, listSkills } from "./skills/loader.js";
import { getProactiveSuggestions, isProactiveEnabled, setProactiveEnabled } from "./proactive.js";
import { SessionStore } from "./session-store.js";
import { ToolPermissionMode } from "./tools/registry.js";
import { createGoal, formatGoalBadge, getGoal, isGoalCreationArgs } from "./goal.js";
import { VERSION } from "./version.js";
import { shellDisplayName } from "./platform/shell.js";
import {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  formatAskUserQuestionForTerminal,
  normalizeAskUserQuestionAnswer,
  parseAskUserQuestionSelection,
  UserQuestionResolver
} from "./tools/user-question.js";

export const MAGI_TEXT_HAT = ["  △", " /✦\\", "▔▔▔"].join("\n");

export function formatTuiStartupBanner(input: {
  cwd: string;
  modelDisplay: string;
  version?: string;
}): string {
  const version = input.version ?? VERSION;
  return [
    "",
    `\x1b[36m  △\x1b[39m   \x1b[1mMagi\x1b[22m \x1b[90mv${version}\x1b[39m`,
    `\x1b[36m /✦\\\x1b[39m  \x1b[90mcwd:\x1b[39m ${input.cwd}`,
    `\x1b[36m▔▔▔\x1b[39m   \x1b[90mmodel:\x1b[39m ${input.modelDisplay}`,
    "",
    "  \x1b[90m/help for commands · Esc/Ctrl+C to interrupt · /exit to quit\x1b[39m",
    ""
  ].join("\n");
}

export interface TuiLiveEventWriter {
  stop: () => void;
  getSessionId: () => string | undefined;
}

export type { TuiTranscriptEntry, TuiTranscriptState } from "./tui/transcript.js";
export {
  buildTuiTranscriptState,
  formatTuiLiveEvent,
  formatTuiTranscriptEntry,
  formatTuiTranscriptStatus
} from "./tui/transcript.js";
export { colorizeDiffLine, createTerminalUserQuestionResolver } from "./tui/interactions.js";

export function installRunningInterruptKeys(
  controller: AbortController,
  input: NodeJS.ReadStream = defaultInput,
  output: NodeJS.WriteStream = defaultOutput,
  options: { activeInteractions?: ActiveInteractionRegistry } = {}
): () => void {
  const wasRaw = input.isRaw;
  let interrupted = false;
  const interrupt = () => {
    if (interrupted || controller.signal.aborted) return;
    interrupted = true;
    output.write("\n\x1b[33mInterrupting...\x1b[39m\n");
    controller.abort();
  };
  const onData = (chunk: Buffer | string) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const approvalPending =
      options.activeInteractions?.listInteractions({ status: "pending", kind: "approval" })
        .length ?? 0;
    if (text === "\x1b" && approvalPending > 0) return;
    if (text === "\x1b" || text === "\x03") interrupt();
  };
  input.setRawMode(true);
  input.resume();
  input.on("data", onData);
  return () => {
    input.off("data", onData);
    input.setRawMode(Boolean(wasRaw));
  };
}

export function initialTuiPermissionMode(mode?: ToolPermissionMode): ToolPermissionMode {
  return mode ?? "default";
}

export async function runInteractiveTerminal(inputConfig: {
  cwd: string;
  config: MagiConfig;
  store: SessionStore;
  paths?: MagiPaths;
  env?: NodeJS.ProcessEnv;
  modelAlias?: string;
  sessionId?: string;
  permissionMode?: ToolPermissionMode;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<number> {
  const input = inputConfig.input ?? defaultInput;
  const output = inputConfig.output ?? defaultOutput;

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
        ? all.filter(
            (cmd) =>
              cmd.name.startsWith(partial) || (cmd.aliases ?? []).some((a) => a.startsWith(partial))
          )
        : all;
      if (matches.length === 0) {
        return [[], line];
      }
      // If single match, complete it directly
      if (matches.length === 1) {
        return [[`/${matches[0].name} `], line];
      }
      // Show all matches with descriptions
      const maxName = Math.max(...matches.map((c) => c.name.length));
      const display = matches.map((cmd) => `/${cmd.name.padEnd(maxName)}  ${cmd.description}`);
      // Print the menu above the prompt
      output.write("\n" + display.join("\n") + "\n");
      return [[`/${partial}`], line];
    }
  });
  let currentModel = inputConfig.modelAlias ?? "main";
  let currentSessionId = inputConfig.sessionId;
  let currentPermissionMode: ToolPermissionMode = initialTuiPermissionMode(
    inputConfig.permissionMode
  );
  let running = false;
  let abortController: AbortController | null = null;
  const modelDisplay = inputConfig.config.models.aliases[currentModel] ?? currentModel;
  output.write(formatTuiStartupBanner({ cwd: inputConfig.cwd, modelDisplay }));
  writeGoalBadge(output, inputConfig.paths, currentSessionId);
  // Show a setup hint if no provider is configured
  const aliasCount = Object.keys(inputConfig.config.models?.aliases ?? {}).length;
  const providerCount = Object.keys(inputConfig.config.providers ?? {}).length;
  if (providerCount === 0 || aliasCount === 0) {
    output.write(
      [
        "\x1b[33m  ⚠ No provider is configured.\x1b[39m",
        "    \x1b[90mRun 'magi init' (in another shell) to set up a provider, then restart.\x1b[39m",
        ""
      ].join("\n")
    );
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
    // Running: abort the request. The catch block handles the error and
    // returns to the prompt.
    if (!abortController?.signal.aborted) {
      output.write("\n\x1b[33mInterrupting...\x1b[39m\n");
    }
    abortController?.abort();
  };
  rl.on("SIGINT", onSigint);
  const inputHistory: string[] = loadHistory().map(decodeHistoryEntry);
  const slashSuggestionCommands = () => {
    const skillItems = inputConfig.paths
      ? listSkills(inputConfig.paths).map((skill) => ({
          name: skill.name,
          usage: `/${skill.name}`,
          description: `[skill] ${skill.summary}`
        }))
      : [];
    return [
      ...registry.getAll().map((cmd) => ({
        name: cmd.name,
        usage: cmd.usage,
        description: cmd.description,
        aliases: cmd.aliases
      })),
      ...skillItems,
      { name: "continue", usage: "/continue", description: "Continue last response" },
      { name: "exit", usage: "/exit", description: "Quit Magi" }
    ];
  };

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
            history: inputHistory,
            slashCommands: slashSuggestionCommands()
          });
        } catch (err) {
          if ((err as Error).message === "SIGINT" || (err as Error).message === "EOF") {
            return 0;
          }
          throw err;
        }
        rl.resume();
      } else {
        try {
          line = await readTuiPrompt({
            input,
            output,
            prompt: "> ",
            history: inputHistory,
            slashCommands: slashSuggestionCommands()
          });
        } catch (err) {
          if (err instanceof TuiPromptAbortError) {
            return 0;
          }
          throw err;
        }
      }
      let trimmed = line.trim();
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
          const picked = await showSlashMenu({
            stdin: input,
            stdout: output,
            items: [
              ...registry.getAll().map((cmd) => ({ name: cmd.name, description: cmd.description })),
              ...slashSuggestionCommands()
                .filter((item) => item.description.startsWith("[skill]"))
                .map((item) => ({ name: item.name, description: item.description })),
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
            currentModel,
            permissionMode: currentPermissionMode
          });
          if (result) {
            output.write(result + "\n");
            output.write("  /exit or /quit            Quit Magi Next\n");
            output.write(
              "  /continue                 Ask the model to continue its last response\n"
            );
          }
          continue;
        }

        if (parsed.name === "model" && parsed.args.length === 0) {
          const selected = await pickInteractiveModel({
            input,
            output,
            config: inputConfig.config,
            currentModel
          });
          if (!selected) {
            continue;
          }
          currentModel = selected;
          const target = inputConfig.config.models.aliases[selected] ?? selected;
          output.write(`Selected model ${selected}: ${target}\n`);
          continue;
        }

        if (parsed.name === "resume") {
          const selected = await pickInteractiveSession({
            input,
            output,
            store: inputConfig.store,
            initialFilter: parsed.args.join(" ")
          });
          if (!selected) {
            continue;
          }
          currentSessionId = selected;
          output.write(formatSessionResume(inputConfig.store, selected) + "\n");
          writeGoalBadge(output, inputConfig.paths, currentSessionId);
          continue;
        }

        if (parsed.name === "sessions" && parsed.args.length === 0) {
          const selected = await pickInteractiveSession({
            input,
            output,
            store: inputConfig.store
          });
          if (!selected) {
            continue;
          }
          currentSessionId = selected;
          output.write(formatSessionResume(inputConfig.store, selected) + "\n");
          writeGoalBadge(output, inputConfig.paths, currentSessionId);
          continue;
        }

        if (
          (parsed.name === "permissions" || parsed.name === "perms") &&
          parsed.args[0] === "mode" &&
          parsed.args.length <= 1
        ) {
          const selected = await pickInteractivePermissionMode({
            input,
            output,
            currentMode: currentPermissionMode
          });
          if (!selected) {
            continue;
          }
          currentPermissionMode = selected;
          output.write(`${formatPermissionModeUpdate(currentPermissionMode)}\n`);
          continue;
        }

        // State-updating commands
        if (parsed.name === "model" && parsed.args[0]) {
          const selected = resolveModelPickerSelection(inputConfig.config, parsed.args[0]);
          if (selected) currentModel = selected;
        }
        if (
          (parsed.name === "permissions" || parsed.name === "perms") &&
          parsed.args[0] === "mode" &&
          parsed.args[1]
        ) {
          const selected = parsePermissionMode(parsed.args.slice(1).join(" "));
          if (selected) {
            currentPermissionMode = selected;
          }
        }
        const isGoalStartCommand = parsed.name === "goal" && isGoalCreationArgs(parsed.args);
        let interactiveGoalStart: InteractiveGoalStartResult | undefined;
        if (parsed.name === "clear") {
          currentSessionId = inputConfig.store.createSession({
            title: "",
            cwd: inputConfig.cwd,
            metadata: { mode: "interactive", clearedFrom: currentSessionId }
          });
        }

        let result: string | Promise<string> | undefined;
        if (isGoalStartCommand) {
          interactiveGoalStart = startInteractiveGoalCommand({
            paths: inputConfig.paths,
            store: inputConfig.store,
            sessionId: currentSessionId,
            cwd: inputConfig.cwd,
            args: parsed.args
          });
          currentSessionId = interactiveGoalStart.sessionId;
          result = interactiveGoalStart.message;
        } else {
          result = await registry.dispatch(parsed.name, parsed.args, {
            cwd: inputConfig.cwd,
            config: inputConfig.config,
            store: inputConfig.store,
            paths: inputConfig.paths,
            sessionId: currentSessionId,
            currentModel,
            permissionMode: currentPermissionMode
          });
        }
        if (result !== undefined) {
          output.write(`${result}\n`);
          if (parsed.name === "goal") {
            writeGoalBadge(output, inputConfig.paths, currentSessionId);
          }
          if (isGoalStartCommand) {
            trimmed = interactiveGoalStart?.prompt ?? parsed.args.join(" ");
            // Continue into the normal prompt flow so /goal <objective>
            // both starts the goal and immediately asks the agent to work it.
          } else {
            continue;
          }
        }
        // Check if this is a user-installed skill (e.g., /commit, /review-pr)
        if (isGoalStartCommand) {
          // Already converted to a normal prompt above.
        } else if (inputConfig.paths) {
          const skill = findSkill(inputConfig.paths, parsed.name);
          if (skill) {
            // Inject skill body as the prompt; let the model handle it
            const skillArgs =
              parsed.args.length > 0 ? `\n\nArguments: ${parsed.args.join(" ")}` : "";
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
      const modelDisplayInline = inputConfig.config.models?.aliases?.[currentModel] ?? currentModel;
      const spinner = startSpinner(output, { model: modelDisplayInline });
      const controller = new AbortController();
      abortController = controller;
      const liveEvents = startTuiLiveEventWriter({
        store: inputConfig.store,
        env: inputConfig.env,
        output,
        stdin: input,
        sessionId: currentSessionId,
        interactions: activeInteractions,
        rl,
        spinner,
        signal: controller.signal
      });
      running = true;
      const startedAt = Date.now();
      let streamedAny = false;
      const usedTools = new Set<string>();
      let hadErrors = false;
      const lastEventTextParts: string[] = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      const md = createStreamingMarkdown();
      // Attach any images queued by /image. encodePromptWithImages adds a
      // sentinel-prefixed block that the agent loop parses back into multi-part
      // user messages.
      const pendingImages = takePendingImages();
      const promptWithImages =
        pendingImages.length > 0 ? encodePromptWithImages(trimmed, pendingImages) : trimmed;
      if (pendingImages.length > 0) {
        output.write(
          `\x1b[90m[attaching ${pendingImages.length} image${pendingImages.length === 1 ? "" : "s"}]\x1b[39m\n`
        );
      }
      let result: Awaited<ReturnType<typeof runHeadlessPrompt>> | undefined;
      let stopInterruptKeys: (() => void) | undefined;
      try {
        stopInterruptKeys = installRunningInterruptKeys(controller, input, output, {
          activeInteractions
        });
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
          permissionMode: currentPermissionMode,
          signal: controller.signal,
          onStreamEvent: (event: AgentQueryEvent) => {
            if (event.type === "text_delta") {
              if (!streamedAny) spinner.stop();
              streamedAny = true;
              const rendered = md.push(event.text);
              if (rendered) output.write(rendered);
              lastEventTextParts.push(event.text);
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
              output.write(
                `\x1b[90m[context compacted: ${event.sourceMessageCount} messages, ~${event.estimatedTokensBefore} tokens]\x1b[39m\n`
              );
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
        stopInterruptKeys?.();
        abortController = null;
        spinner.stop();
        const remaining = md.flush();
        if (remaining) output.write(remaining);
        liveEvents.stop();
        activeInteractions.close();
      }
      running = false;
      currentSessionId = result.sessionId;
      writeGoalBadge(output, inputConfig.paths, currentSessionId);
      if (!streamedAny && result.message) {
        output.write(`${result.message}\n`);
      } else if (streamedAny) {
        output.write("\n");
      }
      const elapsed = Date.now() - startedAt;
      const secs = (elapsed / 1000).toFixed(1);
      const tokenInfo =
        totalInputTokens > 0
          ? ` · ${formatTokens(totalInputTokens)}↑ ${formatTokens(totalOutputTokens)}↓`
          : "";
      output.write(`\n\x1b[90m${result.model ?? currentModel} · ${secs}s${tokenInfo}\x1b[39m\n`);

      // Proactive suggestions
      const suggestions = getProactiveSuggestions({
        toolNames: [...usedTools],
        lastMessage: lastEventTextParts.join("") || result.message,
        hadErrors
      });
      if (suggestions.length > 0) {
        output.write(`\x1b[90m${suggestions.map((s) => `→ ${s}`).join("  ")}\x1b[39m\n`);
      }
    }
  } finally {
    rl.removeListener("SIGINT", onSigint);
    rl.close();
  }
}

export function startTuiLiveEventWriter(input: {
  store: SessionStore;
  env?: NodeJS.ProcessEnv;
  output?: Pick<Writable, "write">;
  stdin?: NodeJS.ReadStream;
  sessionId?: string;
  afterEventId?: number;
  interactions?: ActiveInteractionRegistry;
  rl?: Pick<ReadlinePromisesInterface, "question">;
  spinner?: { pause(): void; resume(): void };
  signal?: AbortSignal;
}): TuiLiveEventWriter {
  const terminalOutput = input.output ?? defaultOutput;
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
    const line = formatTuiLiveEvent(toEventView(event), {
      showToolTrace: input.env?.MAGI_DEBUG_TOOLS === "1"
    });
    if (line) {
      terminalOutput.write(`${line}\n`);
    }
    if (input.interactions && input.rl) {
      // Pause the spinner so the approval prompt isn't clobbered by the
      // animation. Resume after the user resolves it.
      input.spinner?.pause();
      void handleTuiPendingInteraction({
        event: toEventView(event),
        interactions: input.interactions,
        rl: input.rl,
        stdin: input.stdin,
        output: terminalOutput,
        handled: handledInteractions,
        signal: input.signal
      }).finally(() => {
        input.spinner?.resume();
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
  return (
    [
      "Recent sessions:",
      ...sessions.map((session, index) => {
        const marker = index === 0 ? ">" : " ";
        return `${marker} ${session.id}  ${session.updatedAt}  ${session.messageCount} msg  ${session.title ?? "(untitled)"}  ${session.cwd}`;
      }),
      "Use magi -r <session-id> -p <prompt> or magi resume <session-id>."
    ].join("\n") + "\n"
  );
}

export function formatSessionResume(store: SessionStore, sessionId: string): string {
  const session = store.getSession(sessionId);
  if (!session) {
    return `Session not found: ${sessionId}\n`;
  }
  const pending = store
    .listSessionAuditEvents(sessionId, 50)
    .map(toEventView)
    .filter(
      (event) =>
        event.status === "pending" &&
        (event.category === "approval" || event.category === "question")
    );
  const events = store.listSessionAuditEvents(sessionId, 8).map(toEventView);
  const transcript = buildTuiTranscriptState(
    store.listSessionAuditEvents(sessionId, 50).map(toEventView),
    {
      sessionId,
      limit: 8
    }
  );
  const renderState = buildTuiRenderState({
    events: store.listSessionAuditEvents(sessionId, 50).map(toEventView),
    sessionId,
    cwd: session.cwd,
    limit: 8
  });
  return [
    `sessionId: ${session.id}`,
    `title: ${session.title ?? "(untitled)"}`,
    `cwd: ${session.cwd}`,
    `messages: ${session.messages.length}`,
    ...session.messages.map((message) => `${message.role}: ${message.content}`),
    renderTuiState(renderState, { color: false, width: 100, maxBlocks: 8 }),
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
      const toolUseId =
        typeof event.metadata.toolUseId === "string"
          ? event.metadata.toolUseId
          : (event.target ?? "unknown");
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

export async function collectPastedContinuations(
  rl: LineEmitter,
  firstLine: string,
  windowMs = 100
): Promise<string> {
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function writeGoalBadge(
  terminalOutput: Pick<Writable, "write">,
  paths: MagiPaths | undefined,
  sessionId: string | undefined
): void {
  if (!paths || !sessionId) {
    return;
  }
  const badge = formatGoalBadge(getGoal(paths, sessionId));
  if (badge) {
    terminalOutput.write(`\x1b[90m${badge}\x1b[39m\n`);
  }
}

export interface InteractiveGoalStartResult {
  sessionId: string;
  message: string;
  prompt: string;
}

export function startInteractiveGoalCommand(input: {
  paths: MagiPaths | undefined;
  store: SessionStore;
  sessionId: string | undefined;
  cwd: string;
  args: string[];
}): InteractiveGoalStartResult {
  const prompt = input.args.join(" ");
  const sessionId =
    input.sessionId ??
    input.store.createSession({
      title: prompt.slice(0, 80) || "goal",
      cwd: input.cwd,
      metadata: { mode: "interactive", command: "goal" }
    });
  return {
    sessionId,
    message: startInteractiveGoal(input.paths, sessionId, input.args),
    prompt
  };
}

function startInteractiveGoal(
  paths: MagiPaths | undefined,
  sessionId: string | undefined,
  args: string[]
): string {
  if (!paths) return "Goal requires a configured paths root.";
  if (!sessionId)
    return "No active session. Send a message first or resume a session, then use /goal.";
  const objective = args.join(" ").trim();
  const goal = createGoal(paths, { sessionId, objective });
  return `Goal started: ${goal.objective}`;
}

async function pickInteractiveModel(input: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  config: MagiConfig;
  currentModel: string;
}): Promise<string | undefined> {
  const items: TuiPickerItem[] = buildModelPickerItems(input.config, input.currentModel);
  if (items.length === 0) {
    input.output.write(
      "No model aliases configured.\nUse /model <provider:model> after configuring the provider.\n"
    );
    return undefined;
  }
  return showTuiPicker({
    stdin: input.input,
    stdout: input.output,
    title: "models",
    items,
    emptyMessage: "No matching models",
    footer: "↑↓ select · Tab complete · Enter switch · Esc cancel",
    maxVisibleItems: 10
  });
}

export function buildModelPickerItems(config: MagiConfig, currentModel: string): TuiPickerItem[] {
  const items: TuiPickerItem[] = [];
  const routerConfigured = config.models.router && Object.keys(config.models.router).length > 0;
  if (routerConfigured) {
    items.push({
      label: "auto",
      value: "auto",
      description: "smart routing",
      detail: currentModel === "auto" ? "current" : undefined
    });
  }
  for (const [alias, target] of Object.entries(config.models.aliases)) {
    items.push({
      label: alias,
      value: alias,
      description: target,
      detail: alias === currentModel ? "current" : undefined
    });
  }
  return items;
}

async function pickInteractivePermissionMode(input: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  currentMode: ToolPermissionMode;
}): Promise<ToolPermissionMode | undefined> {
  const selected = await showTuiPicker({
    stdin: input.input,
    stdout: input.output,
    title: "permission modes",
    items: buildPermissionModePickerItems(input.currentMode),
    emptyMessage: "No matching permission modes",
    footer: "↑↓ select · Tab complete · Enter switch · Esc cancel",
    maxVisibleItems: 4
  });
  return parsePermissionMode(selected);
}

export function buildPermissionModePickerItems(currentMode: ToolPermissionMode): TuiPickerItem[] {
  return PERMISSION_MODES.map((mode) => ({
    label: formatPermissionModeLabel(mode),
    value: mode,
    description: permissionModePickerDescription(mode),
    detail: mode === currentMode ? `current · ${mode}` : mode
  }));
}

function permissionModePickerDescription(mode: ToolPermissionMode): string {
  switch (mode) {
    case "default":
      return "ask before non-read-only tools";
    case "acceptEdits":
      return "allow ordinary edits and commands without approval";
    case "dontAsk":
      return "deny non-read-only tools instead of asking";
    case "bypassPermissions":
      return `skip prompts; dangerous ${shellDisplayName()} needs explicit env approval`;
    case "plan":
      return "deny write tools";
  }
}

export async function pickInteractiveSession(input: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  store: SessionStore;
  initialFilter?: string;
}): Promise<string | undefined> {
  const sessions = input.store.listSessions(50);
  if (sessions.length === 0) {
    input.output.write("No sessions\n");
    return undefined;
  }
  return showTuiPicker({
    stdin: input.input,
    stdout: input.output,
    title: "resume sessions",
    items: buildSessionPickerItems(input.store),
    emptyMessage: "No matching sessions",
    initialFilter: input.initialFilter,
    footer: "↑↓ select · Tab complete · Enter resume · Esc cancel",
    maxVisibleItems: 10
  });
}

export function buildSessionPickerItems(store: SessionStore): TuiPickerItem[] {
  return store.listSessions(50).map((session) => ({
    label: session.title ? formatSessionTitle(session.title) : shortSessionId(session.id),
    value: session.id,
    description: `${session.messageCount} msg`,
    detail:
      `${session.updatedAt} ${session.cwd} ${session.title ? shortSessionId(session.id) : ""}`.trim()
  }));
}

function formatSessionTitle(title: string): string {
  const singleLine = title.replace(/\s+/g, " ").trim();
  if (!singleLine) return "(untitled)";
  return singleLine.length <= 48 ? singleLine : `${singleLine.slice(0, 47)}…`;
}

function shortSessionId(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 8);
}
