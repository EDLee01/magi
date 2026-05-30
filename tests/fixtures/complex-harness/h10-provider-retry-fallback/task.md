Verify provider retry and fallback resilience.

Requirements:
- Read `docs/provider-retry.md` after the provider route recovers.
- Use the configured fallback route if the primary provider keeps returning retryable server errors.
- Verify retry diagnostics are emitted as provider retry events, not session error events.
- Verify the backup provider recovers the task.
- Do not change package.json, docs, tests, generated files, src files, or files outside this repo.
- Write a concise report to `reports/provider-retry-report.md`.
- Keep the final answer concise and include the report path.
