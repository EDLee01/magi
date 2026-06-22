# v0.1.9 Compatibility Delta

## Runtime

| Area | v0.1.8 | v0.1.9 | Required action |
| --- | --- | --- | --- |
| Node.js | `>=20` | `>=22` | Upgrade to Node.js 22 or 24 before installation. |
| Vitest | Compatible range from 3.0.8 | Exact 3.2.6 | Use the committed lockfile in development and CI. |
| Package contents | Runtime files | Runtime files plus capability manifest | No action required. |

## Permission Behavior

`acceptEdits` now means automatic approval for workspace file edits only:

- Automatically allowed: `FileWrite`, `FileEdit`, `FilePatch`.
- Not automatically allowed: shell commands, network access, remote access,
  process/state changes, and destructive operations.
- Explicit allow/deny rules still take priority.
- `bypassPermissions` behavior is unchanged.

Automation that relied on `acceptEdits` to run commands must add scoped rules,
for example `Bash(npm:*)`, or deliberately use `bypassPermissions` in an
isolated trusted environment.

## Control API

Job `cwd` values must resolve to an existing real path inside the daemon
workspace. The server rejects:

- absolute or relative paths outside the workspace;
- symlink escapes;
- nonexistent paths;
- paths that fail realpath/stat validation.

Clients should omit `cwd` to use the workspace root or send a workspace-relative
directory that already exists.

## SSH

Remote paths are now quoted as data, not executable shell fragments. Writes are
transferred as base64 over stdin and decoded remotely. Returned sizes are byte
counts, including for non-ASCII content.

## Daemon

The daemon stores a local CLI credential under its state directory with mode
`0600`; the daemon directory is mode `0700`. `magi daemon kill` authenticates
using this credential. v0.1.8 ignores the additional credential file.

## State

No state migration is required. Automated install/upgrade/rollback testing
verified that an active goal created by v0.1.8 remains readable in v0.1.9 and
after rollback to v0.1.8.
