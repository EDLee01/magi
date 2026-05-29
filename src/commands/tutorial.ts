/**
 * `magi tutorial` — a 5-minute interactive walkthrough.
 *
 * Prints a guided overview of the most useful commands and concepts.
 * No real model calls; just text + asks the user to press Enter between sections
 * so they can absorb each step. Press `q` at any prompt to skip out early.
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const HEADER = "\x1b[1m\x1b[36m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

interface Section {
  title: string;
  body: string[];
}

const SECTIONS: Section[] = [
  {
    title: "1. The basics",
    body: [
      "Magi is a TUI for AI-assisted coding.",
      "",
      "  magi                    Start the interactive TUI",
      '  magi -p "hello"        Run a one-shot prompt and exit',
      "  magi --version          Show version",
      "  magi doctor             Show config paths and runtime info",
      "",
      "Inside the TUI, type a question and Enter to send. Use Ctrl+C to interrupt.",
      "Type /help anytime to list commands."
    ]
  },
  {
    title: "2. Models and routing",
    body: [
      "Configure a provider with `magi init` first (sets up aliases: fast/main/review/deep).",
      "",
      "  /model                  Show current model + picker",
      "  /model fast             Use the haiku alias (cheap)",
      "  /model auto             Smart routing — picks model per task",
      '  /route test "<prompt>"  Preview which model auto would pick',
      "",
      "Auto picks haiku for short questions, sonnet for code, opus for planning."
    ]
  },
  {
    title: "3. Files and editing",
    body: [
      "Magi has tools to read/edit files in the current workspace.",
      "",
      '  Read a file:           ask "show me src/index.ts"',
      '  Edit a file:           ask "add error handling to src/foo.ts:42"',
      '  Search the repo:       ask "find all uses of fooBar"',
      "",
      'After non-trivial changes, ask "verify" to run the verify skill —',
      "it builds and tests automatically."
    ]
  },
  {
    title: "4. Sessions",
    body: [
      "Each conversation is a session, persisted to ~/.magi-next/state/sessions.sqlite.",
      "",
      "  /sessions               List recent sessions (in TUI)",
      "  magi sessions           Same, from CLI",
      "  magi resume <id>        Resume a session",
      "  /clear                  Start a new session",
      "  /export <path>          Save current session as markdown",
      "  /fork                   Branch off a copy",
      "  /rewind                 Drop the last assistant turn"
    ]
  },
  {
    title: "5. Skills (reusable workflows)",
    body: [
      "Skills are markdown files that the agent invokes for repeatable tasks.",
      "",
      "  /skill                  List installed skills",
      "  /verify                 Built-in skill: build + test + verdict",
      "  /debug                  Built-in skill: investigate a bug",
      "  /commit-msg             Built-in skill: draft commit message",
      "",
      "Add your own at ~/.magi-next/skills/<name>/SKILL.md."
    ]
  },
  {
    title: "6. Memory",
    body: [
      "Memory stores durable context across sessions after you apply a Memory Draft.",
      "",
      "  /memory list            List Memory files",
      "  /memory drafts          List pending Memory Drafts",
      "  /memory draft apply <id> Apply a reviewed draft",
      "",
      "The agent uses the Memorize tool to propose drafts.",
      "It does not write formal Memory until you apply the draft."
    ]
  },
  {
    title: "7. Multi-machine + remote control",
    body: [
      "Each Magi can run as a daemon and discover others on the LAN.",
      "",
      "  magi daemon start       Run control API + mDNS in background",
      "  magi peers              Discover other Magi instances",
      "  magi pair <name>        Generate a token for your phone",
      "  /tasks                  See running background jobs",
      "",
      "Open the panel URL on your phone — control your dev machine remotely."
    ]
  },
  {
    title: "8. Sub-agents and parallel work",
    body: [
      "The Agent tool lets the model spawn sub-agents for sub-tasks.",
      "",
      "  Agent({ subagent_type: 'explore', prompt: '...' })       cheap research",
      "  Agent({ subagent_type: 'verification', prompt: '...' })  build/test",
      "  Agent({ target: 'peer-X', ... })                         dispatch to a peer",
      "",
      "Multiple Agent calls in the same response run in parallel."
    ]
  },
  {
    title: "Done",
    body: [
      "That's the core. A few more starting points:",
      "",
      "  /help                   Full slash-command list",
      "  magi config             Show effective config",
      "  ~/.magi-next/           Your config + state",
      "",
      "Have fun. Run /tutorial again any time to refresh."
    ]
  }
];

export async function runTutorial(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\n${HEADER}Magi tutorial${RESET}\n`);
    stdout.write(`${DIM}Press Enter to advance, q to quit.${RESET}\n\n`);
    for (let i = 0; i < SECTIONS.length; i++) {
      const s = SECTIONS[i];
      stdout.write(`\n${BOLD}${CYAN}${s.title}${RESET}\n`);
      for (const line of s.body) {
        stdout.write(`${line}\n`);
      }
      if (i < SECTIONS.length - 1) {
        const answer = await rl.question(`\n${DIM}— Enter to continue, q to quit —${RESET} `);
        if (answer.trim().toLowerCase() === "q" || answer.trim().toLowerCase() === "quit") {
          stdout.write(`\nGoodbye!\n`);
          return;
        }
      }
    }
    stdout.write(`\n`);
  } finally {
    rl.close();
  }
}
