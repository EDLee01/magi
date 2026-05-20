# Troubleshooting

Common errors with what to do about them.

## Setup

### `Provider "anthropic" needs the environment variable ANTHROPIC_AUTH_TOKEN to be set`

You haven't exported your API key. Add to your shell profile:

```sh
echo 'export ANTHROPIC_AUTH_TOKEN="sk-ant-..."' >> ~/.zshrc
source ~/.zshrc
magi doctor                  # confirm it's set
```

If your provider isn't Anthropic, the env var name will be different — `magi
init` will guide you.

### `No provider is configured`

You haven't run `magi init` yet. Run it interactively:

```sh
magi init
```

Or skip the wizard if you have an env var set:

```sh
ANTHROPIC_AUTH_TOKEN=... magi init -y
```

### `Could not parse ~/.magi-next/config.yaml as YAML`

Common causes:
- Tabs instead of spaces (YAML rejects tabs).
- An unquoted URL with a `:` (e.g. `baseUrl: https://...`).
- A list missing the `- ` prefix.

Fix the file or delete it and run `magi init` again.

## Provider errors

### `anthropic returned HTTP 401 (authentication failed)`

Your API key is wrong, expired, or for a different account.

- Run `magi doctor` to see which env var is being used.
- Check the value: `echo $ANTHROPIC_AUTH_TOKEN | head -c 20`.
- If you use a proxy (like a custom `baseUrl`), the proxy may have its own
  auth — check the proxy's docs.

### `anthropic returned HTTP 502 (server error, likely transient)`

The provider's API is down or your proxy returned 502. Magi will retry
automatically. If it keeps failing:

- Check the provider's status page.
- If using a proxy, try setting `baseUrl` to the official endpoint
  (`https://api.anthropic.com`) temporarily.

### `anthropic returned HTTP 429 (rate limit)`

You've hit your quota. Magi backs off and retries. If you see this often:

- Switch to a smaller model (`/model fast`).
- Use `/model auto` so cheap prompts use haiku, not sonnet.

### `anthropic returned HTTP 404 (model not found)`

The model name is wrong. Run `/model` to see configured aliases. The actual
model name is shown in parentheses. Common cause: the provider deprecated an
old model — update `~/.magi-next/config.yaml` or run `magi init` to refresh.

## Daemon and remote control

### `Magi daemon is not running` (when running `magi kill` or `magi pair`)

Start it first:

```sh
magi daemon start
```

### Daemon stops unexpectedly / auto-restart

The `magi daemon start` command spawns a single Node process and writes a
PID file. It does **not** auto-restart on crash or after a reboot.

For production use, run it under a real supervisor:

**macOS (launchd):**

`~/Library/LaunchAgents/com.magi.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.magi.daemon</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/magi</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>ANTHROPIC_AUTH_TOKEN</key><string>...</string>
    <key>MAGI_CONTROL_BIND</key><string>0.0.0.0</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.magi.daemon.plist
```

**Linux (systemd --user):**

`~/.config/systemd/user/magi.service`:

```ini
[Unit]
Description=Magi Next daemon
After=network.target

[Service]
ExecStart=/usr/local/bin/magi serve
Environment=ANTHROPIC_AUTH_TOKEN=...
Environment=MAGI_CONTROL_BIND=0.0.0.0
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now magi
```

### Cannot reach daemon from phone (LAN)

By default, daemon binds to `127.0.0.1` (loopback only). For LAN access:

```sh
magi daemon stop
MAGI_CONTROL_BIND=0.0.0.0 magi daemon start
magi pair my-phone     # then scan/open the URL it prints
```

Make sure your firewall allows the daemon's port (default 8765).

### `magi peers` discovers no peers

Common causes:
- mDNS is blocked on your network (corporate Wi-Fi often does this).
- The other daemon isn't running, or has `MAGI_DISABLE_MDNS=1`.
- Different subnets (mDNS is single-LAN only).

Workaround: use IP directly.

```sh
magi peers add peer-2 http://192.168.1.50:8765 <device-id> <token>
```

### `Peer rejected the request: token is invalid or expired`

Pairing tokens expire after 10 minutes (or 1 hour if extended). Re-pair:

```sh
# On the peer:
magi pair refreshed
# Save the new credentials locally:
magi peers add peer-2 <url> <new-device-id> <new-token>
```

## Sessions and state

### Lost a session / can't find it

```sh
magi sessions             # show recent
magi resume <id>
```

Sessions are stored in `~/.magi-next/state/sessions.sqlite`. Backups are your
responsibility — copy that file to keep history.

### `/clear` accidentally cleared the wrong session

`/clear` starts a new session; the old one is still in the database.
`/sessions` will show it.

### Disk full

Clear caches:

```sh
rm -rf ~/.magi-next/cache
```

Or if `sessions.sqlite` itself is huge (rare), VACUUM:

```sh
sqlite3 ~/.magi-next/state/sessions.sqlite "VACUUM;"
```

## Tools and skills

### Skill `/<name>` not running anything

The slash command path runs the skill. If the agent doesn't act, the agent's
model may not have understood. Ask explicitly:

```
> Run the verify skill
```

The model uses the skill body as its instructions.

### Bash tool denied / asks for approval every time

By default, every Bash invocation asks. To allow specific commands without
approval:

```yaml
permissions:
  allow:
    - "Bash(npm test*)"
    - "Bash(git status*)"
```

In `~/.magi-next/config.yaml`. Or use `acceptEdits` permission mode for the
session.

### Image attachment ignored

```
/image ./screenshot.png
```

Then immediately send your prompt. The image attaches to that one prompt.
The model has to support vision (anthropic sonnet/opus does, deepseek doesn't).

## TUI

### Output looks garbled (missing colors, weird boxes)

Your terminal may not support TrueColor or 256-color. Set `TERM=xterm-256color`,
or disable color: `magi --no-color` or `NO_COLOR=1 magi`.

### Prompt input is slow / Ctrl+C exits the wrong thing

Magi uses `readline/promises` for input. If you're on a very old Node version,
upgrade to ≥ 20. Bracketed paste (multi-line paste detection) only works on
modern terminals (iTerm2, kitty, Apple Terminal, recent Linux/Windows).

## Getting help

If something isn't covered above:

```sh
magi doctor               # config + paths
magi --version
```

Open an issue with both outputs and the command you ran.
