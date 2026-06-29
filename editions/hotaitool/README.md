# Magi HotAITool Edition

This directory is a **separate distribution** from the main `@edwardlee5423/magi` package.
The main `magi` CLI and source tree do not include HotAITool-specific presets, env
detection, or auto-bootstrap logic.

## What you get

- Binary: `magi-hotaitool`
- Config root: `~/.magi-hotaitool` (not `~/.magi-next`)
- Dual providers:
  - `hotaitool-claude` → `https://www.hotaitool.net` + `/v1/messages`
  - `hotaitool-openai` → `https://www.hotaitool.net/v1` + `/chat/completions`

## Install (from this repo)

```sh
cd editions/hotaitool
npm install
npm run build
npm link
```

You also need the main Magi package built/linked:

```sh
cd ../..
npm install
npm run build
npm link
```

## Setup

```sh
magi-hotaitool setup
# edit ~/.magi-hotaitool/provider.env with your key(s)
magi-hotaitool setup   # writes config.yaml once credentials exist
magi-hotaitool -p "hello"
```

### provider.env example

```bash
ANTHROPIC_AUTH_TOKEN=sk-...
ANTHROPIC_BASE_URL=https://www.hotaitool.net
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://www.hotaitool.net/v1
```

## Commands

| Command | Purpose |
|---------|---------|
| `magi-hotaitool setup` | Create `~/.magi-hotaitool` and write HotAITool config |
| `magi-hotaitool doctor` | Edition report + `magi doctor` |
| `magi-hotaitool` | Same as `magi`, but uses the HotAITool config root |

## Isolation from main Magi

| | Main `magi` | `magi-hotaitool` |
|--|-------------|------------------|
| Package | `@edwardlee5423/magi` | `@edwardlee5423/magi-hotaitool` |
| Config dir | `~/.magi-next` | `~/.magi-hotaitool` |
| HotAITool code in `src/` | No | Only under `editions/hotaitool/` |
