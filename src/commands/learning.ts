import {
  applyLearningDraft,
  formatLearningDraftList,
  formatLearningDraftReview,
  listLearningDrafts,
  rejectLearningDraft
} from "../learning-draft.js";
import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "learning",
  aliases: ["learn"],
  description: "Review and apply Magi LearningDrafts",
  usage: "/learning [drafts|draft show|apply|reject <id>]",
  group: "Memory",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (!input.paths) {
      return "LearningDraft paths are unavailable";
    }
    const rootInput = {
      appRoot: input.paths.root,
      memoryRoot: input.config.memory.root,
      skillsRoot: input.paths.skillsRoot
    };
    const sub = args[0] ?? "drafts";
    if (sub === "drafts" || sub === "list") {
      return formatLearningDraftList(listLearningDrafts(rootInput));
    }
    if (sub === "draft") {
      const action = args[1];
      const id = args[2];
      if (!action || !id) return "Usage: /learning draft <show|apply|reject> <id>";
      if (action === "show") return formatLearningDraftReview({ ...rootInput, id });
      if (action === "apply")
        return `Applied LearningDraft: ${applyLearningDraft({ ...rootInput, id }).id}`;
      if (action === "reject")
        return `Rejected LearningDraft: ${rejectLearningDraft({ ...rootInput, id }).id}`;
      return `Unknown LearningDraft action: ${action}`;
    }
    return `Unknown learning command: ${sub}. Usage: ${command.usage}`;
  }
};
