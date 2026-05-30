# Provider Retry Policy

Retryable provider failures should be observable without looking like a failed user session.

- Transient primary failures emit provider retry diagnostics.
- Retry diagnostics must not become `session.error` events when the session later succeeds.
- If the primary route exhausts fast retries, the configured fallback provider should recover the task.
