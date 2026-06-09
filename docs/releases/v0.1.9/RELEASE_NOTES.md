# Magi Next v0.1.9 Release Notes

Release date: 2026-06-09

## Purpose

v0.1.9 is a compatibility-preserving hardening release based on the verified
v0.1.8 baseline. It does not add Computer Use. The release focuses on runtime
support, command safety, permission boundaries, remote file correctness,
Control API workspace isolation, and reliable upgrade/rollback evidence.

## Changes

- Raised the supported runtime floor from Node.js 20 to Node.js 22.
- Added a preflight check and CI coverage for Node.js 22, plus experimental
  Node.js 24 coverage.
- Pinned Vitest to 3.2.6 and refreshed the lockfile, license report, and SBOM.
- Added `capability-manifest.json` as the explicit product capability boundary.
- Replaced shell-interpolated system-tool commands with argument-vector
  execution or JavaScript filtering.
- Added injection regression coverage for disk usage, process listing, process
  termination, executable lookup, and screenshot capture.
- Split tool permissions into read, workspace-edit, command, network, remote,
  state-change, and destructive risk classes.
- Limited `acceptEdits` automatic approval to `FileWrite`, `FileEdit`, and
  `FilePatch`. Commands and higher-risk operations still require an explicit
  rule or approval.
- Corrected SSH remote command quoting, binary-safe file writes, and byte
  reporting. Added fake transport tests and a real localhost OpenSSH smoke test.
- Preserved existing file modes during atomic replacement.
- Restricted Control API job working directories to real paths inside the
  daemon workspace, including symlink escape rejection.
- Added protected local daemon credentials and authenticated `magi daemon kill`.
- Added repeatable upgrade/rollback and localhost SSH smoke scripts.
- Removed repository pollution from worktree-related tests.

## Verified Results

- Unit/integration: 54 files, 682 tests passed.
- Black-box CLI: 31 scenarios, score 1.00, 0 regressions.
- Complex task harness: 10 scenarios, score 1.00, 0 regressions.
- Model task benchmark: 19 scenarios, score 1.00, 0 regressions.
- Capability alignment: 8/8 checks passed, score 1.00.
- Aggregate evaluation evidence: 423 provider calls and 759 tool calls.
- Real model smoke: passed against an OpenAI-compatible Responses API using
  `gpt-5.4`; source patch, focused test, and generated report were verified.
- Real SSH smoke: passed against an isolated localhost OpenSSH daemon.
- Upgrade/rollback: v0.1.8 -> v0.1.9 -> v0.1.8 passed with active goal state
  preserved.
- Rust runner build, secret scan, license scan, SBOM generation, and npm audit
  passed. npm audit reported 0 known vulnerabilities across 179 packages.

## Compatibility Notes

Node.js 20 is no longer supported. See `COMPATIBILITY_DELTA.md` for permission
and Control API behavior changes.

## Known Limits

- The TUI is partial and does not yet have full transcript regression coverage.
- Subagent writes do not yet require worktree isolation.
- Control API remote workflows are not yet validated across separate machines.
- The Rust runner does not yet enforce an operating-system sandbox.
- Memory, Control API, subagents, and the Rust runner remain beta capabilities.
- Computer Use remains explicitly outside the Magi product boundary.

## Rollback

Use the matching v0.1.8 package artifact and follow `ROLLBACK.md`. The automated
rollback smoke confirms that active goal state survives install, upgrade, and
rollback.
