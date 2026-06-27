# Magi Next v0.1.12 — Feishu Remote, TUI Stability

Date: 2026-06-26

## Highlights

- **Feishu bridge**: session continuity, AskUserQuestion forwarding, dedupe, and
  locale-aware replies for headless chat.
- **Remote control**: router can authorize a broad default workspace while denying
  destructive tools even in yolo mode.
- **TUI**: fix Apple Terminal crashes during prompt redraw on input.

## Feishu bridge

- Forward `AskUserQuestion` interactions to Feishu cards (`interaction_mode =
  client`).
- Persist `sessionId` per chat for multi-turn continuity; `/new` clears session.
- Mirror user language in replies (`response_language = auto`).
- Dedupe inbound messages and harden daemon single-instance startup.
- Document yolo + router `denyDestructive` setup in `config.example.toml`.

## Control API / headless

- `control.defaultCwd`, `control.allowAnyCwd`, and `control.denyDestructive`
  for remote-safe workspaces.
- Deny destructive tools (`FileDelete`, `GitReset`, `Bash(rm*)`, etc.) before
  permission bypass applies.
- `interactionMode: client` vs `auto` for headless question handling.
- Feishu locale nudge and capability nudge steer WebSearch over Brief.

## TUI

- Prompt redraw uses per-line `\x1b[2K` clear and absolute column positioning
  instead of screen erase + forward cursor moves, avoiding Apple Terminal
  crashes during typing.

## Tests

- `tests/prompt-reader.test.ts`, `tests/remote-safe-tools.test.ts`,
  `tests/headless-interactions.test.ts`, `tests/feishu-locale-nudge.test.ts`
