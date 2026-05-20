# Magi Next Clean-room Plan

Version: 0.1 planning draft  
Date: 2026-05-15  
Directory: `/home/claude-user/magi-next`

## 1. Decision

Use a **TS-first product validation path** with a **Rust sidecar and Rust portable-core roadmap**.

This replaces the earlier Rust-first plan. The reason is practical: Magi is LLM-native, and v0.1-v0.2 need fast iteration on provider routing, tool loop, approvals, MCP, TUI, memory, and mobile control. TypeScript gets us there faster. Rust is still required, but it should enter where it has clear leverage: PTY, sandbox, process control, audit, packaging, and later HarmonyOS PC CLI.

## 2. Naming

New directory: `/home/claude-user/magi-next`

Rationale:
- It clearly separates the clean-room project from existing `/home/claude-user/magi`.
- It avoids accidentally editing or publishing the legacy codebase.
- It leaves room for the product to become `Magi` later when the replacement is real.

CLI entrypoint:

- New clean-room entrypoint: `magi`.
- Legacy private entrypoint: `magi-agent`.
- Magi Next must not publish or install a `magi-agent` binary.
- v0.1 acceptance requires `magi`, `magi -p`, `magi doctor`, and `magi config` to work directly.
- This naming boundary is part of the product separation strategy: users enter the next-generation clean-room tool with `magi`, while the old private tool remains isolated behind `magi-agent`.

## 2.1 Mandatory Isolation Matrix

Magi Next must be isolated from legacy Magi in command names, disk paths, environment variables, ports, logs, caches, and plugin state.

| Surface | Magi Next | Legacy / forbidden |
| --- | --- | --- |
| CLI binary | `magi` | `magi-agent` |
| npm package | `@magi/cli` or `magi` after name availability check | `magi-agent` |
| Development config root | `~/.magi-next/` | `~/.claude/`, `~/.claude/magi/` |
| Future stable config root | `~/.magi/` | legacy Magi directories |
| Config file | `~/.magi-next/config.yaml` in development; `~/.magi/config.yaml` when promoted | `~/.claude/settings.json` |
| State root | `~/.magi-next/state/` | legacy state roots |
| Session store | `~/.magi-next/sessions/` or `~/.magi-next/state/sessions.sqlite` | legacy session storage |
| Logs | `~/.magi-next/logs/` | legacy logs |
| Cache | `~/.magi-next/cache/` | legacy cache |
| Plugins | `~/.magi-next/plugins/` | `.claude-plugin`, legacy plugin cache |
| Skills | `~/.magi-next/skills/` | legacy skill directories |
| Mobile devices | `~/.magi-next/devices/` | legacy bridge/trusted-device state |
| Env prefix | `MAGI_*` | `CLAUDE_*` as primary config |
| Control API port | `8765` by default, configurable with `MAGI_CONTROL_PORT` | legacy bridge/server ports |
| Bind address | `127.0.0.1` by default | public bind without explicit opt-in |

Isolation rules:

- Magi Next may import a user-selected migration file only through an explicit `magi migrate` command.
- Magi Next must not auto-read legacy state.
- Magi Next must not mutate legacy state.
- Magi Next must not infer provider credentials from `CLAUDE_*` variables unless a future migration command explicitly copies them into `MAGI_*` config with user confirmation.
- `magi doctor` must report the active config root, state root, log root, and whether any legacy path access was detected.
- CI must include an isolation test that fails if code references forbidden paths as runtime defaults.

## 3. Non-negotiable Compliance Boundary

Magi Next may preserve behavior and product requirements, but not code lineage.

Allowed:
- Behavior-equivalent commands.
- Behavior-equivalent configuration concepts.
- User workflow parity.
- Black-box tests written from expected behavior.
- New implementation using public API docs and clean-room specs.

Not allowed:
- Copying old source code.
- Translating or renaming old implementation.
- Copying prompts, tests, docs, UI strings, or file layout from the legacy project.
- Claude Web/OAuth integration.
- Claude in Chrome compatibility.
- Anthropic remote bridge.
- Official Claude plugin marketplace compatibility.

## 4. Feature Decisions

### Must Keep

The following capabilities are required:

- Interactive terminal UI.
- Headless one-shot mode.
- Slash command system.
- Session resume and history.
- Diff approval.
- Keyboard-focused workflow.
- Provider registry.
- Model aliases.
- Fallback routing.
- Per-task routing.
- Intelligent task-to-model routing.
- Model capability profiles.
- Route quality monitoring.
- Uptime Kuma monitoring integration.
- Usage and cost tracking.
- File read/search.
- File edit.
- Shell execution.
- Git awareness.
- Web fetch and summarize.
- Image input and screenshot analysis.
- Execution sandbox.
- AGENTS.md rule loading.
- Project memory.
- User long-term preferences.
- Memory view/edit command.
- Context budget view.
- Context compaction.
- Subagents.
- Explorer / Worker roles.
- Task queue and continuation.
- Agent logs.
- Concurrent write conflict policy.
- MCP client.
- MCP approval.
- Plugin system.
- Skill system.
- Custom plugin marketplace.
- Self-hosted remote runner.
- Lightweight web panel.
- GitHub integration.
- Secret scanning.
- Dependency license scanning.
- SBOM.
- Telemetry off by default.
- Network allowlist.
- Audit log.
- MIT or Apache-2.0 license.
- Clean-room record.
- Quality gate.
- User documentation.
- Configuration migrator.
- Magi brand identity.

### Must Exclude

- Official Claude plugin marketplace compatibility.
- Claude Web / OAuth login.
- Claude in Chrome compatibility.
- Anthropic remote bridge.

### Conditional Keep

- OpenAI Responses / Chat adapter: keep in v0.1.
- Messages-compatible provider adapter: keep, but only for explicit user-provided API keys, base URLs, and models. Do not connect to Claude Web credentials.

## 5. Technology Stack

### v0.1-v0.2 Mainline

- Core / CLI: TypeScript + Node.js LTS + pnpm.
- TUI: Ink or a clean-room terminal renderer.
- Provider routing: TypeScript adapters over a shared internal message/tool IR.
- Intelligent routing: TypeScript task classifier, capability profiles, route scorer, and quality history.
- Session store: SQLite.
- Config: YAML or JSON.
- API server: Node HTTP framework with OpenAPI schema.
- Web panel: React + Vite.
- Mobile control API: HTTP JSON + SSE, with WebSocket only if bidirectional realtime becomes necessary.

### Rust Sidecar

Rust starts as a separate `magi-runner` for:

- PTY and process execution.
- Shell command policy.
- File diff application.
- Sandbox boundary.
- Audit event emission.
- Cross-platform packaging experiments.

### Mobile Clients

Mobile apps are control and approval clients:

- HarmonyOS phone/tablet: ArkTS + ArkUI.
- iOS: Swift + SwiftUI.
- Android: Kotlin + Jetpack Compose.

They should not execute arbitrary shell locally.

### HarmonyOS PC

HarmonyOS PC is a desktop target, separate from phone/tablet:

- v0.4: technical validation.
- v0.5: experimental CLI package if validation passes.
- Preferred long-term path: Rust portable CLI.
- Interim path: compatible Linux arm64/x64 CLI if HarmonyOS PC provides a suitable environment.
- Optional GUI shell: ArkTS/ArkUI app that talks to local `magi serve`.

## 6. System Architecture

```text
Magi Next v0.1-v0.2
  TypeScript Core
    ├─ CLI commands
    ├─ TUI
    ├─ Agent loop
    ├─ Provider router
    ├─ Intelligent route scorer
    ├─ Route quality monitor
    ├─ Tool coordinator
    ├─ Approval engine
    ├─ Session store
    ├─ Memory layer
    ├─ MCP client
    ├─ Plugin/skill layer
    ├─ Control API
    └─ Monitoring exporters

  Rust Sidecar
    ├─ PTY
    ├─ Shell execution
    ├─ File diff apply
    ├─ Sandbox policy
    └─ Audit events

  Clients
    ├─ CLI / TUI
    ├─ Web panel
    ├─ Mobile apps
    └─ Remote runner

  Monitoring
    ├─ Magi route probes
    ├─ Route quality SQLite history
    ├─ Uptime Kuma push monitors
    └─ Web panel route status
```

Long-term:

```text
Magi Next v0.4-v0.5
  Stable TS product layer
  Rust runner strengthened
  Rust portable core extracted for HarmonyOS PC CLI
```

## 6.1 Intelligent Routing and Monitoring

Intelligent routing is a core Magi Next capability. It is not the same as
simple provider fallback.

Primary routing decision:

- Classify the task: quick chat, coding, code review, planning, extraction,
  summarization, long-context, tool-heavy, vision, or agent orchestration.
- Match the task to model capability profiles.
- Choose the best model/provider route based on capability fit first.

Secondary route scoring:

- Current availability.
- Rolling success rate.
- p95 latency.
- Timeout rate.
- 429/5xx rate.
- Estimated cost.
- Context length.
- Structured-output support.
- Tool-use reliability.

Uptime Kuma integration:

- Uptime Kuma is used for monitoring, alerts, and status pages.
- Magi Next remains responsible for task classification, route scoring,
  circuit breaking, and model selection.
- The first integration target is Kuma Push Monitor. Magi sends heartbeat
  results for each configured route after probes or live calls.
- Do not depend on Uptime Kuma internal management APIs for core routing logic.

Target behavior:

- `magi routes classify <prompt>` reports the inferred task kind.
- `magi routes choose <prompt>` reports candidate routes and the selected route.
- `magi routes status` reports recent quality metrics.
- Headless and TUI requests use the intelligent router by default unless
  `--model` explicitly overrides it.
- Fallback remains available when the selected route fails.

## 7. Version Roadmap

### v0.1.0-alpha: Multi-route CLI Work Loop

Goal: usable clean-room CLI that can run real coding tasks.

Includes:
- `magi`, `magi -p`, `magi doctor`, `magi config`.
- No `magi-agent` binary.
- Isolated development roots under `~/.magi-next/`.
- Primary environment variables use `MAGI_*`.
- `magi doctor` reports isolation status.
- OpenAI Chat/Responses provider.
- Messages-compatible provider.
- Provider registry, aliases, fallback, per-task routing.
- File read/search/edit.
- Bash execution with approval.
- Git status/diff awareness.
- Session store.
- Usage/cost tracking.
- MIT or Apache-2.0 license.
- Clean-room log.
- Secret scan and license scan.

Excludes:
- Full TUI polish.
- MCP.
- Subagents.
- Mobile app.
- HarmonyOS PC support claim.

### v0.2.0-alpha: TUI, Memory, MCP, Mobile Control API

Includes:
- Interactive TUI.
- Slash commands.
- Session resume.
- AGENTS.md loading.
- Project memory and user preference memory.
- MCP client.
- MCP tool approval.
- `magi serve`.
- Pairing, jobs, SSE events, approvals, devices, audit API.
- Web approval panel.

### v0.3.0-alpha: Multi-agent and Rust Runner

Includes:
- Explorer / Worker roles.
- Subagent task queue.
- Agent logs.
- Concurrent write conflict policy.
- Context budget view.
- Context compaction.
- Rust runner for PTY/process/file-diff/sandbox.

### v0.4.0-alpha: Plugins, Skills, Web Panel, Mobile App

Includes:
- Plugin manifest.
- Custom plugin marketplace.
- Skill system.
- Lightweight web panel.
- First native mobile app on the highest-priority platform.
- HarmonyOS PC technical validation report.

### v0.5.0-alpha: HarmonyOS PC CLI Experimental

Includes, if validation passes:
- `magi-harmony-pc` experimental package.
- HarmonyOS PC install guide.
- HarmonyOS PC smoke results.
- Native or compatible CLI path clearly labeled.

## 8. Mobile Control API

The API is already drafted:

- HTML: `/dl/magi-mobile-control-api.html`
- OpenAPI: `/dl/magi-mobile-control-openapi.json`

Core resources:

- Device.
- Session.
- Job.
- Event.
- Approval.
- Provider.
- AuditRecord.

Required flows:

1. CLI starts pairing.
2. Mobile scans QR or enters pairing code.
3. CLI confirms device.
4. Mobile creates job.
5. Mobile subscribes to SSE events.
6. Mobile approves or rejects high-risk tools.
7. CLI writes audit records.

## 9. Quality Gates

### TypeScript Mainline

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:integration`
- `pnpm test:openapi`

### Rust Sidecar

- `cargo fmt --check`
- `cargo clippy -- -D warnings`
- `cargo test`

### Release and Compliance

- Secret scan.
- Dependency license scan.
- SBOM generation.
- Clean-room log review.
- No legacy-source references.
- Provider smoke only with real user-provided credentials.

## 10. Hour-level Schedule

The detailed feature schedule is in `planning/feature-schedule.csv`.

Summary:

- H1-H4: clean-room bootstrap.
- H5-H18: TypeScript CLI skeleton, config, session, provider IR.
- H19-H34: provider routing, fallback, usage/cost, headless loop.
- H35-H52: file tools, bash approval, git awareness.
- H53-H64: v0.1 quality gate and alpha package.
- H65-H88: TUI, slash commands, AGENTS.md, memory.
- H89-H108: MCP, mobile control API, web approval panel.
- H109-H132: subagents, task queue, context budget/compaction.
- H133-H152: Rust runner sidecar.
- H153-H176: plugin/skill/custom marketplace.
- H177-H204: mobile app first platform.
- H205-H228: HarmonyOS PC validation and experimental CLI decision.

## 11. Key Risks

### Rust Too Early

Risk: slows v0.1-v0.2 product validation.

Mitigation: TS-first, Rust sidecar later.

### TS Core Later Needs Rust Port

Risk: double-maintenance.

Mitigation: keep stable internal protocol boundaries from v0.1: message IR, tool IR, approval schema, event schema.

### HarmonyOS PC Unknowns

Risk: terminal, PTY, process, signing, filesystem, TLS differences.

Mitigation: do not claim support until smoke tests run on real HarmonyOS PC or official supported environment.

### Feature Parity Pressure

Risk: trying to rebuild everything at once.

Mitigation: versioned delivery. v0.1 restores multi-route CLI workflow first.

## 12. Delivery Artifacts

- `/home/claude-user/magi-next` planning and future code directory.
- `planning/magi-next-plan.md`.
- `planning/feature-schedule.csv`.
- nginx HTML plan.
- OpenAPI mobile control spec.
- Clean-room implementation repository when coding starts.
