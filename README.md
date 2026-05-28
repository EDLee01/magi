# Magi Next

A TypeScript-first AI coding agent for the terminal. Run a smart agent locally,
control it from your phone over the LAN after pairing a device, and dispatch
sub-agents to peer machines.

```
$ magi
  △   Magi · 89 tools
 /✦\  cwd: ~/code/my-project
▔▔▔   model: openai:gpt-5.5

  /help for commands · Ctrl+C to interrupt · /exit to quit

> refactor src/auth.ts to use the new session API
```

## Quick start

```sh
# Install from this repository
git clone https://github.com/EDLee01/magi.git
cd magi
npm install
npm run build
npm link

# Set one provider key
export OPENAI_API_KEY="<your-key>"
# or: export ANTHROPIC_AUTH_TOKEN="<your-key>"
# or: export DEEPSEEK_API_KEY="<your-key>"

# Configure (interactive)
magi init

# Use it
magi                            # Interactive TUI
magi -p "explain this repo"     # One-shot prompt
```

If you don't set a key first, `magi init` will tell you which env var to set
and bail out cleanly.

## What it does well

- **Real agent loop with parallel tool calls** — file ops, shell, git, web,
  MCP servers, sub-agents.
- **Smart routing** — `/model auto` picks the configured fast/main/deep
  aliases by task kind.
- **Plan mode** — `EnterPlanMode` for non-trivial work, ask for approval
  before implementing.
- **Cross-machine agents** — discover other Magi daemons via mDNS, dispatch
  sub-agents with `target: 'peer-name'`.
- **Mobile control** — start a LAN-bound daemon, run `magi pair`, open the
  printed `/panel` URL on your phone, then enter the Device ID and Token.
- **Persistent memory** — durable facts written to `~/.magi-next/memdir/`
  auto-load into future sessions.
- **Learning Loop v1** — recalls relevant prior sessions, memory, and skills
  before work; creates reviewable LearningDrafts after reusable lessons.
- **Skills** — bundled `verify` / `debug` / `stuck` / `commit-msg` /
  `review-pr`. Add your own by dropping a `SKILL.md` file or applying an
  approved skill LearningDraft.

## Five-minute tutorial

```sh
magi tutorial
```

Walks through 8 sections (basics, models, files, sessions, skills, memory,
multi-machine, sub-agents). Press `q` to quit early.

## Common commands

| Command                    | What it does                              |
|---------------------------|-------------------------------------------|
| `magi`                    | Start interactive TUI                     |
| `magi -p "<prompt>"`       | One-shot prompt, stream output            |
| `magi init`               | Interactive provider setup                |
| `magi doctor`             | Show config + paths                       |
| `magi sessions`           | List recent sessions                      |
| `magi resume <id>`        | Resume a session                          |
| `magi memory search <q>`   | Search durable Memory                     |
| `magi learning list`       | List reviewable LearningDrafts            |
| `magi learning draft <show|apply|reject> <id>` | Review or resolve a LearningDraft |
| `magi ps`                 | List recent jobs                          |
| `magi logs <job-id>`      | Show events for a job                     |
| `magi daemon start`       | Run control API in background             |
| `magi pair <name>`        | Generate a token for phone access         |
| `magi peers`              | Discover Magi daemons on the LAN          |
| `magi tutorial`           | Walkthrough                               |

Inside the TUI, type `/help` to list slash commands. Type `/help <name>` for
details on one.

## Learning Loop

Magi now performs a local-first recall pass before provider calls. It retrieves
relevant durable Memory, installed skills, and prior session snippets, then
injects them as fenced background context. Recalled text is context, not a new
user instruction.

After explicit learning requests or sufficiently complex tasks, Magi can create
a pending LearningDraft under `~/.magi-next/state/learning-drafts/`. Drafts can
target Memory, new skills, skill patches, or `do_not_save`; they do not mutate
Memory or skills until you apply them.

```sh
magi learning list
magi learning draft show <id>
magi learning draft apply <id>
magi learning draft reject <id>
```

Agents can also discover the deferred `SessionSearch`, `LearningDraft`, and
`SkillManage` tools through `ToolSearch`. `SkillManage` is path-limited to the
configured skills root and requires normal write approval outside bypass modes.

## Configuration

`~/.magi-next/config.yaml`:

```yaml
providers:
  openai:
    type: openai
    apiKeyEnv: OPENAI_API_KEY
    baseUrl: https://api.openai.com/v1
    defaultModel: gpt-5.5
models:
  aliases:
    fast:   openai:gpt-5.5
    main:   openai:gpt-5.5
    review: openai:gpt-5.5
    deep:   openai:gpt-5.5
  router:               # used when alias = "auto"
    fast:   { family: gpt, role: haiku,  contextWindow: 200000, supportsVision: true }
    main:   { family: gpt, role: sonnet, contextWindow: 200000, supportsVision: true }
    deep:   { family: gpt, role: opus,   contextWindow: 200000, supportsVision: true }
```

Run `magi init` to generate a working config and skip the manual yaml.
It supports OpenAI, Anthropic, and DeepSeek credentials.

## Cross-machine setup

```sh
# On each machine you want to use:
MAGI_CONTROL_BIND=0.0.0.0 magi daemon start

# On your "main" machine, see who's around:
magi peers

# Pair another machine (run on the peer to get a token):
magi pair from-peer
# → outputs a Device ID + Token

# On main, save the credentials:
magi peers add peer-2 http://192.168.1.50:8765 <device-id> <token>

# Now in the TUI, the agent can dispatch to peer-2:
> compare the auth modules in this repo and the one on peer-2
```

The agent uses the `Agent` tool with `target: "peer-2"` to dispatch
sub-agents. Multiple targets in the same response run in parallel.

## Phone access

```sh
# The default daemon bind is 127.0.0.1, which a phone cannot reach.
magi daemon stop
MAGI_CONTROL_BIND=0.0.0.0 magi daemon start

magi pair my-phone
# → prints Device ID, Token, and one or more URLs like:
#   http://192.168.1.10:8765/panel
```

Open the printed `/panel` URL on a phone connected to the same LAN, then enter
the printed Device ID and Token. Tokens are not placed in the URL. The current
CLI prints URLs and credentials; it does not generate a QR code.

## Documentation

- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — common errors and fixes
- [ARCHITECTURE.md](ARCHITECTURE.md) — concepts and component map
- [docs/magi-next-learning-loop-v1.html](docs/magi-next-learning-loop-v1.html)
  — Learning Loop v1 design and shipped scope
- `magi tutorial` — interactive walkthrough

## State and isolation

Everything lives at `~/.magi-next/` by default:

```
~/.magi-next/
  config.yaml          # provider + model setup
  state/sessions.sqlite  # persisted sessions, jobs, audit, usage
  state/learning-drafts/ # reviewable post-task learning proposals
  memory/              # formal review-applied Memory files
  memdir/              # typed long-term memory (user/feedback/project/reference)
  skills/<name>/SKILL.md
  logs/                # daemon logs
  cache/
  plugins/
  devices/
```

Override the root with `MAGI_CONFIG_DIR=/path` for testing or sandboxing.

## Building from source

```sh
git clone <this-repo>
cd magi-next
npm install
npm run build
npm test
```

Requires Node ≥ 20.

## Status

Active development. The core agent loop, routing, MCP, daemon, multi-machine
dispatch, and mobile web panel are implemented and covered by tests. Beta
quality; APIs and UX may still change.

Filing bugs: open a GitHub issue with output of `magi doctor` and `magi --version`.
