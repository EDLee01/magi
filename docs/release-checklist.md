# v0.1 Alpha Gate Checklist

## Required Commands

- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run scan:secrets`
- `npm run scan:licenses`
- `npm run sbom`
- `npm run verify`

## Isolation Checklist

- Package binary is only `magi`.
- No `magi-agent` binary is published.
- Default root is `~/.magi-next/`.
- Test override root is `MAGI_CONFIG_DIR`.
- Primary environment prefix is `MAGI_*`.
- `CLAUDE_*` is not used as primary configuration.
- Default Control API bind is `127.0.0.1`.
- Default Control API port is `8765`.
- Legacy paths are not runtime defaults.

## Clean-room Checklist

- Do not copy source, prompts, tests, docs, or file structure from legacy Magi.
- Do not add Claude Web/OAuth implementation.
- Do not add Claude in Chrome implementation.
- Do not add Anthropic remote bridge implementation.
- Do not add official Claude plugin marketplace compatibility.
