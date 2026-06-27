# Magi Next v0.1.13 — Web Capability Reliability

Date: 2026-06-27

## Fixes

- **Capability questions**: inject reminders into the user prompt instead of a
  trailing system message so models stop denying web access on meta questions
  like “你可以联网搜索么”.
- **URL tasks**: detect prompts with a specific URL and nudge the agent to call
  WebFetch first instead of WebSearch-guessing whether the page exists.
- **WebFetch core tool**: promote WebFetch to the initial core tool list so it
  matches the system prompt and is available on the first turn.

## Tests

- `tests/capability-nudge.test.ts`
- `tests/tool-registry.test.ts`
