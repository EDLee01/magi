Add --dry-run support to the notes CLI.

Requirements:
- Reproduce the current test result first.
- Update the CLI so `node src/cli.js add --title "Plan" --dry-run` reports what would be saved without modifying data/notes.json.
- Keep normal add/list behavior working.
- Update tests and README usage.
- Do not change package.json, generated files, or files outside this repo.
- Run the focused test again after the change.
- Keep the final answer concise and include the verification result.
