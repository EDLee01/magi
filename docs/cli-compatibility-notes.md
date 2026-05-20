# CLI Compatibility Notes

These notes come from black-box command observation only. Legacy source code,
prompts, tests, and file layout were not read or copied.

Observed compatibility targets:

- Default command starts an interactive session.
- `-p` / `--print` runs a single prompt and exits.
- `--model <name>` selects a model or alias for the current invocation.
- `-c` / `--continue` continues the most recent session for the current
  directory.
- `-r` / `--resume` is a resume-shaped option in the legacy CLI; Magi Next
  currently provides `magi resume <session-id>` and `/resume <session-id>`.
- `--output-format json` is useful for scripts.
- Help should expose practical commands without relying on legacy-only
  integrations.

Magi Next exclusions remain in force:

- No Claude Web/OAuth implementation.
- No Claude in Chrome implementation.
- No Anthropic remote bridge implementation.
- No official Claude plugin marketplace compatibility.
- No `magi-agent` binary.
