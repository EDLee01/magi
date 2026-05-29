import {
  formatModelPicker,
  formatModelTarget,
  resolveModelPickerSelection,
  SlashCommandInput
} from "./registry.js";

export const command = {
  name: "model",
  description: "Show or switch model alias",
  usage: "/model [alias]",
  group: "Model",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (args.length > 0) {
      const selected = resolveModelPickerSelection(input.config, args[0]);
      if (!selected) {
        return [
          `Model not configured: ${args[0]}`,
          formatModelPicker(input.config, input.currentModel)
        ].join("\n");
      }
      return `Selected model ${selected}: ${formatModelTarget(input.config, selected)}`;
    }
    return formatModelPicker(input.config, input.currentModel);
  }
};
