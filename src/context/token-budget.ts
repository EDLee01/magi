import { ContextSummaryRecord, MessageRecord, SessionRecord } from "../session-store.js";

export interface ContextCategoryBudget {
  category: string;
  chars: number;
  estimatedTokens: number;
  items: number;
}

export interface SessionContextBudget {
  sessionId: string;
  messageCount: number;
  summaryCount: number;
  chars: number;
  estimatedTokens: number;
  categories: ContextCategoryBudget[];
}

export function estimateTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  const asciiWords = normalized.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const nonWhitespaceChars = normalized.replace(/\s+/g, "").length;
  return Math.max(1, Math.ceil(Math.max(nonWhitespaceChars / 4, asciiWords * 1.25)));
}

export function computeSessionContextBudget(input: {
  session: SessionRecord;
  summaries?: ContextSummaryRecord[];
}): SessionContextBudget {
  const buckets = new Map<string, { chars: number; items: number }>();

  for (const message of input.session.messages) {
    const category = messageCategory(message);
    addBucket(buckets, category, message.content.length);
  }

  for (const summary of input.summaries ?? []) {
    addBucket(buckets, "summary", summary.summary.length);
  }

  const categories = Array.from(buckets.entries())
    .map(([category, value]) => ({
      category,
      chars: value.chars,
      estimatedTokens: estimateTokens("x".repeat(value.chars)),
      items: value.items
    }))
    .sort(
      (a, b) =>
        categoryOrder(a.category) - categoryOrder(b.category) ||
        a.category.localeCompare(b.category)
    );

  const chars = categories.reduce((sum, category) => sum + category.chars, 0);
  return {
    sessionId: input.session.id,
    messageCount: input.session.messages.length,
    summaryCount: input.summaries?.length ?? 0,
    chars,
    estimatedTokens: categories.reduce((sum, category) => sum + category.estimatedTokens, 0),
    categories
  };
}

export function formatSessionContextBudget(budget: SessionContextBudget): string {
  const lines = [
    `sessionId: ${budget.sessionId}`,
    `messages: ${budget.messageCount}`,
    `summaries: ${budget.summaryCount}`,
    `chars: ${budget.chars}`,
    `estimatedTokens: ${budget.estimatedTokens}`,
    "categories:"
  ];

  for (const category of budget.categories) {
    lines.push(
      `  ${category.category}: ${category.estimatedTokens} tokens, ${category.chars} chars, ${category.items} items`
    );
  }

  return `${lines.join("\n")}\n`;
}

function messageCategory(message: MessageRecord): string {
  if (message.metadata.kind === "context-summary") {
    return "summary";
  }
  if (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "tool" ||
    message.role === "system"
  ) {
    return message.role;
  }
  return "other";
}

function addBucket(
  buckets: Map<string, { chars: number; items: number }>,
  category: string,
  chars: number
): void {
  const existing = buckets.get(category) ?? { chars: 0, items: 0 };
  existing.chars += chars;
  existing.items += 1;
  buckets.set(category, existing);
}

function categoryOrder(category: string): number {
  const index = ["system", "user", "assistant", "tool", "summary", "other"].indexOf(category);
  return index === -1 ? 999 : index;
}
