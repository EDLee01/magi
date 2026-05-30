Refactor duplicate parsing logic while keeping behavior unchanged.

Requirements:
- Run the current focused test first.
- Preserve the public output for all existing report commands.
- Extract the duplicated comma-separated parsing logic into `src/parse.js`.
- Update `src/sales.js` and `src/inventory.js` to use the shared helper.
- Do not change package.json, tests, generated files, or files outside this repo.
- Run the focused test again after the refactor.
- Keep the final answer concise and include the verification result.
