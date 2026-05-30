Validate the Bash approval boundary through the Control API.

Requirements:
- Read `docs/bash-approval-policy.md` first.
- Use the Magi CLI available at `$MAGI_CLI_UNDER_TEST`.
- Start a real Control API job in default permission mode.
- Verify that read-only Bash runs without approval.
- Verify that non-read-only Bash requires approval and exposes command, cwd, and timeout details.
- Resolve the approval through the Control API and verify the approved Bash command completes.
- Do not change package.json, docs, tests, generated files, src files, or files outside this repo.
- Write a concise report to `reports/bash-approval-report.md`.
- Keep the final answer concise and include the report path.
