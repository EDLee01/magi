# Magi Next for VS Code

Send code, files, and selections from VS Code to your local Magi Next agent.

## Prerequisites

1. Install Magi Next: `npm install -g @magi/cli` (or run from source)
2. Start the control API: `magi control start` (defaults to `127.0.0.1:8765`)
3. Configure a provider in `~/.magi-next/config.yaml`

## Commands

- **Magi: Ask with Selection** — right-click selected code, ask Magi a question. The selection is included as a code block with file:line context.
- **Magi: Ask with Current File** — right-click a file in the Explorer or invoke from the command palette. Sends an `@file` mention.
- **Magi: Open Session** — opens the web panel at the control endpoint.
- **Magi: Configure Control API Endpoint** — change the endpoint URL.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `magiNext.controlEndpoint` | `http://127.0.0.1:8765` | Magi Next control API URL |
| `magiNext.controlToken` | `""` | Optional bearer token |
| `magiNext.modelAlias` | `auto` | Model alias to use (auto / fast / main / deep) |

## How it works

The extension talks to the running Magi Next process via the HTTP control API:

1. Creates a session at `POST /sessions` with the workspace as cwd
2. Posts the prompt at `POST /sessions/{id}/messages` (returns a `jobId`)
3. Streaming output is available at `GET /jobs/{jobId}/events` (SSE)

For now, output is shown in the Output panel. A richer streaming UI is planned.

## Development

```bash
cd extensions/vscode
npm install
npm run compile
# Then F5 in VS Code with this folder open to launch an Extension Development Host
```
