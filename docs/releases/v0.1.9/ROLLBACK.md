# Magi Next v0.1.9 Rollback

## Preconditions

- Stop active Magi jobs before replacing the global package.
- Keep the v0.1.8 package artifact and its checksum.
- Do not delete `~/.magi-next`; v0.1.8 and v0.1.9 share the compatible state
  contract verified by the rollback smoke.

## Procedure

```bash
magi daemon kill || true
npm install -g ./edwardlee5423-magi-0.1.8.tgz
magi --version
magi doctor
```

The expected version output contains `0.1.8`.

## State Check

```bash
magi goal
magi sessions
```

Confirm that the expected active goal and recent sessions remain visible.

## Optional Cleanup

After the v0.1.8 daemon is stopped, the v0.1.9 local daemon credential may be
removed if required by local policy:

```bash
rm -f ~/.magi-next/state/daemon/local-cli-token
```

The exact state root can be overridden by `MAGI_CONFIG_DIR`; apply cleanup only
to the intended isolated configuration directory.

## Recovery

If v0.1.8 does not start, restore the configuration directory from the backup
taken before installation and reinstall the checksum-verified v0.1.8 artifact.
Do not attempt ad hoc SQLite edits.
