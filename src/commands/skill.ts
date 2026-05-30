import { listSkills, findSkill, formatSkillList } from "../skills/loader.js";
import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "skill",
  aliases: ["skills"],
  description: "List installed skills or show details for one",
  usage: "/skills [name]",
  group: "Skills",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (!input.paths) {
      return "Skills require a configured paths root (run from a normal session).";
    }
    if (args.length === 0) {
      const skills = listSkills(input.paths);
      if (skills.length === 0) {
        return [
          "No skills installed.",
          "",
          `Skills directory: ${input.paths.skillsRoot}`,
          "Add a skill by creating a directory with a SKILL.md file under that path.",
          "Example: ~/.magi-next/skills/my-skill/SKILL.md"
        ].join("\n");
      }
      return [
        "Installed skills:",
        ...skills.map((s) => `  /${s.name.padEnd(24)} ${s.summary}`),
        "",
        "Use /skill <name> to view a skill's contents.",
        "Use /<name> directly to invoke a skill in conversation."
      ].join("\n");
    }
    const name = args[0]!.replace(/^\//, "");
    const skill = findSkill(input.paths, name);
    if (!skill) {
      return `Skill not found: ${name}. Use /skill to list installed skills.`;
    }
    return [
      `Skill: ${skill.name}`,
      `Root:  ${skill.root}`,
      `Summary: ${skill.summary}`,
      "",
      "--- SKILL.md ---",
      skill.body ?? "(no body)"
    ].join("\n");
  }
};
