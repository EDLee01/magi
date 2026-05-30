Exercise the multi-agent write-claim boundary.

Requirements:
- Read `docs/agent-boundary.md` first.
- Verify that two workers can claim disjoint files: `src/left.txt` and `src/right.txt`.
- Verify that a second worker claiming `src/left.txt` is rejected as a same-file conflict.
- Use the Magi CLI available at `$MAGI_CLI_UNDER_TEST` for the agent queue flow.
- Do not change package.json, docs, src files, generated files, or files outside this repo.
- Write a concise report to `reports/agent-conflict-report.md`.
- Keep the final answer concise and include the report path.
