import { SlashCommandInput } from "./registry.js";
import { executeTaskList, formatTaskListResult } from "../tools/tasks.js";

export const command = {
  name: "todos",
  aliases: ["todo"],
  description: "Show the current session's task list",
  usage: "/todos",
  group: "State",
  handler: (_args: string[], input: SlashCommandInput): string => {
    if (!input.sessionId) return "No active session.";
    if (!input.paths) return "Paths not configured.";
    const result = executeTaskList({
      stateRoot: input.paths.stateRoot,
      sessionId: input.sessionId
    });
    if (!result.tasks || result.tasks.length === 0) {
      return [
        "No tasks in this session yet.",
        "",
        "The agent uses TaskCreate/TaskUpdate to track work on multi-step jobs."
      ].join("\n");
    }
    return formatTaskListResult(result);
  }
};
