# AGENTS.md instructions for /home/claude-user/magi-next

## Scope
This directory is the clean-room planning and future implementation area for Magi Next.

Do not copy source code, prompts, tests, file structure, or UI text from `/home/claude-user/magi` or any other restricted/leaked codebase.

## Product Identity
The product name is `Magi Next` during clean-room development. The user-facing product may later become `Magi` after it fully replaces the private legacy tool.

The new clean-room CLI entrypoint is `magi`.

Do not create a `magi-agent` entrypoint in this project. `magi-agent` is reserved for the legacy private tool and must not be used by Magi Next.

## Mandatory Isolation
Magi Next must be isolated from the legacy Magi tool.

- Binary: use `magi`; never publish `magi-agent`.
- Development config root: `~/.magi-next/`.
- Future stable config root: `~/.magi/`.
- Do not read or write `~/.claude/`, `~/.claude/magi/`, or legacy Magi state.
- Do not use `CLAUDE_*` environment variables as Magi Next primary configuration. Use `MAGI_*`.
- Do not use legacy provider/session/cache/plugin/skill directories.
- Default control API port: `8765`, configurable by `MAGI_CONTROL_PORT`.
- Default local binding: `127.0.0.1`; remote binding must require explicit user opt-in.
- Tests must include an isolation check that fails if Magi Next touches legacy paths or exposes `magi-agent`.

## Architecture Direction
- v0.1-v0.2 use TypeScript-first product validation for speed.
- Rust starts as runner/sandbox/PTY sidecar.
- Rust portable core and HarmonyOS PC CLI support are roadmap items after the product behavior stabilizes.
- Mobile clients are control and approval clients, not shell execution environments.

## Documentation
Planning documents live under `planning/`.

All schedules must use hour-granularity phases such as `H1-H4`.
