Find why the config loader rejects a valid config and fix it.

Requirements:
- Run the current focused test first.
- Investigate the repository before editing: discover relevant files, search for the validation error, and read the loader, validator, and tests.
- A config with `server.port: 0` and `client.retryLimit: 0` is valid.
- Keep existing invalid config checks working.
- Do not change package.json, tests, docs, generated files, or files outside this repo.
- Make the narrowest source change needed.
- Run the focused test again after the fix.
- Keep the final answer concise and include the verification result.
