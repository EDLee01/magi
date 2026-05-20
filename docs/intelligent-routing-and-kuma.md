# Intelligent Routing and Uptime Kuma Integration

Date: 2026-05-16

## Positioning

Intelligent routing is a core Magi Next capability. Uptime Kuma is an external
monitoring and alerting integration. Kuma does not replace Magi's route
decision engine.

Magi owns:

- task classification
- model capability profiles
- route scoring
- explicit `--model` overrides
- fallback and circuit breaker decisions
- route decision audit records

Uptime Kuma owns:

- heartbeat visualization
- alerting
- status pages
- external availability checks

## Target Architecture

```text
User request
  -> Magi task classifier
  -> model capability filter
  -> route quality scorer
  -> selected provider/model route
  -> provider call
  -> usage + quality metrics
  -> route audit event
  -> optional Uptime Kuma push heartbeat
```

## Task Classification

Initial task kinds:

- `quick-chat`
- `coding`
- `code-review`
- `planning`
- `extraction`
- `summarization`
- `long-context`
- `tool-heavy`
- `vision`
- `agent-orchestration`

Classification must be deterministic in v1. A simple rule-based classifier is
acceptable before provider-backed classification exists.

## Model Capability Profile

Each route should have:

- provider name
- model name
- supported task kinds
- reasoning score
- coding score
- review score
- speed score
- stability score
- context window
- tool-use reliability
- structured output support
- vision support
- input cost
- output cost
- optional Uptime Kuma push URL

Example shape:

```yaml
routes:
  profiles:
    fast:
      provider: anthropic
      model: claude-haiku-4-5-20251001
      tasks: [quick-chat, extraction, summarization]
      speed: 0.9
      stability: 0.8
      coding: 0.4
      contextWindow: 200000
      inputCostPerMt: 1.0
      outputCostPerMt: 5.0
      kumaPushUrlEnv: MAGI_KUMA_FAST_PUSH_URL
```

## Route Scoring

Primary score:

```text
taskFit = capability score for inferred task kind
```

Secondary score:

```text
quality = successRate - timeoutPenalty - errorPenalty + latencyScore
cost = normalized estimated cost
score = taskFit * 0.55 + quality * 0.30 + costScore * 0.15
```

`--model` bypasses automatic selection but still records quality metrics.

## Quality Metrics

Record per route:

- timestamp
- provider
- model
- task kind
- latency ms
- success/failure
- error class
- HTTP status when available
- timeout boolean
- input tokens
- output tokens
- estimated cost

Rolling windows:

- last 5 minutes
- last 1 hour
- last 24 hours

## Circuit Breaker

States:

- `closed`: usable
- `open`: temporarily blocked
- `half-open`: probe before restoring

Open when:

- timeout rate exceeds threshold
- 5xx rate exceeds threshold
- repeated provider unavailable errors

Recover after cooldown and successful probe.

## Uptime Kuma Integration

Use Kuma Push Monitor URLs, configured through `MAGI_*` environment variables.

Do:

- push heartbeat after active probes
- push heartbeat after live calls if configured
- include latency and route label in msg/ping fields where supported
- expose route status in Magi Web panel

Do not:

- depend on Uptime Kuma internal admin APIs for core routing
- require Kuma for normal model calls
- put API keys or provider secrets in Kuma messages

## CLI Targets

```bash
magi routes classify "review this diff"
magi routes choose "fix the failing parser test"
magi routes status
magi routes probe
```

Expected behavior:

- `classify` returns task kind and confidence.
- `choose` returns candidate routes, scores, and selected route.
- `status` returns rolling metrics and circuit breaker state.
- `probe` tests configured routes and optionally pushes to Kuma.

## Control API Targets

Endpoints:

- `GET /routes/status`
- `POST /routes/probe`
- `POST /routes/classify`
- `POST /routes/choose`

Web panel:

- route status table
- selected best route by task kind
- recent failures
- circuit breaker state
- Kuma status link fields

## Acceptance Tests

- Review prompt selects review-capable model.
- Coding prompt selects coding-capable model.
- Short prompt selects fast model.
- Long-context prompt avoids small-context models.
- Explicit `--model` overrides auto routing.
- Route with open circuit is skipped.
- Lower-cost route wins only when task fit and quality are comparable.
- Mock Kuma push endpoint receives heartbeat after probe.
- Provider call records route decision and quality metric.

## Implementation Order

1. Route config schema and deterministic classifier.
2. Route chooser CLI and unit fixtures.
3. Route quality SQLite table and status command.
4. Headless integration and audit records.
5. Kuma push heartbeat.
6. Web panel route status.
