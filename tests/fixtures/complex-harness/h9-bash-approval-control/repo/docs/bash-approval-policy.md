# Bash Approval Policy

Default permission mode must distinguish read-only shell inspection from commands that execute project code.

- Read-only Bash commands may run without an approval interaction.
- Non-read-only Bash commands must create an active approval interaction before execution.
- Approval evidence must include the requested command, the workspace cwd, and the timeout.
