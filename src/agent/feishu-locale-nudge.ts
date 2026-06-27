/**
 * Inject locale guidance when the prompt carries a Feishu channel marker.
 */

const FEISHU_LOCALE_MARKER = /\[Feishu[^\]]*\]/i;

const FEISHU_LOCALE_NUDGE = [
  "[Locale reminder]",
  "The user is on Feishu. Reply in the same language as the user's latest message (mirror their language).",
  "Do not switch language mid-response — e.g. do not open in Korean and continue in Chinese.",
  "Sub-agent and tool summaries must use the user's language too."
].join("\n");

export function isFeishuLocalePrompt(prompt: string): boolean {
  return FEISHU_LOCALE_MARKER.test(prompt);
}

export function buildFeishuLocaleNudge(): string {
  return FEISHU_LOCALE_NUDGE;
}
