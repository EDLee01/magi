# Magi Next v0.1.11 — Security Hardening

Date: 2026-06-10

## Purpose

A focused security release that closes a set of vulnerabilities found in an
internal audit of the tool-execution, permission, filesystem and network
surfaces. The common thread across the high-severity issues is **prompt
injection escalating into privileged action**: untrusted content the agent
reads (a web page, a file, a delegated task) steering a tool call into local
command execution, secret disclosure, or internal-network access — often with
no approval prompt.

No functional behavior changes for normal use. The fixes tighten what the agent
is allowed to do with attacker-influenceable input.

## Fixes

### Critical

- **SSH argument injection → local command execution.** `host`/`user` for the
  `SshExec`, `SshFileRead` and `SshFileWrite` tools flowed into `ssh`'s argv
  with no validation and no `--` separator, so a value like
  `-oProxyCommand=…` executed a command on the *operator's* machine before any
  connection. Host/user are now validated against a strict charset and the
  target is placed after `--`. (`src/ssh/exec.ts`)

- **Permission allow-rule bypass via command chaining.** A `Bash(git:*)`
  allow rule matched by prefix only, so `git log && rm -rf /`,
  `git status; curl … | bash` and `git log $(…)` were all auto-allowed with no
  prompt. Allow rules now require a single simple command with no chaining or
  substitution operators; deny rules keep loose matching so they still catch
  chained commands. (`src/tools/registry.ts`, `src/tool-policy.ts`,
  `src/tools/shell.ts`)

- **Dangerous-command denylist bypass.** The `bypassPermissions` backstop only
  recognized a handful of short-flag forms, so `rm --recursive --force /`,
  `chmod -R 777 /`, `chmod 0777 …`, `find … -delete` and `find … -exec` all
  passed as "not dangerous". The denylist now covers long options, recursive
  chmod, world-writable octal/symbolic modes, `find -delete`/`-exec`,
  download-pipe-to-interpreter and fork bombs. (`src/tools/shell.ts`)

### High

- **`Environment` tool leaked all secrets unprompted.** The tool was marked
  read-only (so it ran with no approval) and dumped every `process.env` entry
  verbatim into the model context. Values for variables whose names look
  secret-bearing (`KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`CREDENTIAL`/`AUTH`/…) are
  now redacted. (`src/tools/environment.ts`)

- **SSRF to internal/metadata addresses.** `HttpRequest` and `WebFetch` could
  reach `169.254.169.254` (cloud metadata/IAM credentials), loopback and
  private ranges. A new SSRF guard blocks loopback, link-local, private, CGNAT
  and reserved ranges (IPv4 + IPv6, with DNS resolution). `WebFetch` now follows
  redirects manually and re-validates every hop, so an approved external host
  cannot 302-redirect into an internal address. Explicitly allowlisted hosts
  and an opt-out env var (`MAGI_ALLOW_INTERNAL_REQUESTS=1`) are honored.
  (`src/tools/ssrf-guard.ts`, `src/tools/http-request.ts`,
  `src/tools/web-fetch.ts`)

- **World-readable state at rest.** `sessions.sqlite` (full prompts, executed
  commands, tool output), logs, cron store, permission rules and other state
  were written `0o644` under a `0o775` home. The session DB (+ WAL/SHM), the
  Magi home and state dirs are now `0o700`, and `atomicWrite` defaults to
  `0o600`. (`src/session-store.ts`, `src/paths.ts`, `src/fs-utils.ts`,
  `src/logger.ts`, `src/tools/cron.ts`)

### Medium

- **`FileFind` filesystem-wide enumeration.** It was the only file tool that
  did not confine its search root to the workspace, so `path: "/etc"` or
  `../../` enumerated files anywhere readable (e.g. locating `id_rsa`). The
  search root is now resolved through `resolveWorkspacePath`. (`src/tools/file-find.ts`)

## New behavior knobs

- `MAGI_ALLOW_INTERNAL_REQUESTS=1` — opt out of the SSRF guard for local
  development against loopback/private addresses.

## Tests

- New `tests/security-hardening.test.ts` (19 cases) locks in each fix:
  SSH injection rejection, env redaction, FileFind confinement, SSRF
  block/allow lists, denylist coverage and allow-rule chaining rejection.
- Full suite: 710 tests passing (`691` existing + `19` new), typecheck and
  clean-room lint clean.

## Notes / not yet addressed

Lower-severity items from the audit are tracked for a follow-up: constant-time
device-token comparison, pairing-token single-use enforcement, MCP SSE
`endpoint` same-origin pinning, cron-creation confirmation prompt, and removing
`cwd` from the mDNS TXT record. None are reachable as unauthenticated remote
code execution; they are defense-in-depth.
