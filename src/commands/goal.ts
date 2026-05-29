import {
  createGoal,
  clearGoal,
  formatGoal,
  formatGoalStatus,
  getGoal,
  isGoalCreationArgs,
  listGoals,
  updateGoalStatus
} from "../goal.js";
import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "goal",
  aliases: ["goals"],
  description: "Start or show the current session goal",
  usage: "/goal <objective> | /goal",
  group: "Session",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (!input.paths) return "Goal requires a configured paths root.";
    if (!input.sessionId)
      return "No active session. Send a message first or resume a session, then use /goal.";

    const sub = args[0]?.toLowerCase();
    if (!sub || sub === "status" || sub === "show") {
      return formatGoal(getGoal(input.paths, input.sessionId));
    }
    if (sub === "list") {
      const goals = listGoals(input.paths, input.sessionId);
      if (goals.length === 0) return "No goals for this session.";
      return [
        "Goals for this session:",
        ...goals.map(
          (goal) =>
            `- ${formatGoalStatus(goal.status).padEnd(16)} ${goal.objective} (${goal.updatedAt})`
        )
      ].join("\n");
    }
    if (sub === "done" || sub === "complete" || sub === "completed") {
      const goal = updateGoalStatus(input.paths, {
        sessionId: input.sessionId,
        status: "completed",
        note: args.slice(1).join(" ")
      });
      return goal ? `Goal completed: ${goal.objective}` : "No active goal.";
    }
    if (sub === "blocked" || sub === "block") {
      const goal = updateGoalStatus(input.paths, {
        sessionId: input.sessionId,
        status: "blocked",
        note: args.slice(1).join(" ")
      });
      return goal ? `Goal blocked: ${goal.objective}` : "No active goal.";
    }
    if (
      sub === "cancel" ||
      sub === "cancelled" ||
      sub === "clear" ||
      sub === "reset" ||
      sub === "stop"
    ) {
      const goal = clearGoal(input.paths, input.sessionId);
      return goal ? `Goal cancelled: ${goal.objective}` : "No active goal.";
    }

    if (!isGoalCreationArgs(args)) {
      return "Usage: /goal <objective> | /goal";
    }
    const objective = args.join(" ");
    const goal = createGoal(input.paths, { sessionId: input.sessionId, objective });
    return `Goal started: ${goal.objective}`;
  }
};
