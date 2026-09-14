import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActiveInteractionCancelledError,
  ActiveInteractionRegistry,
  ActiveInteractionTimeoutError
} from "../src/interactions.js";
import { parseTuiInteractionTimeoutMs } from "../src/tui/interactions.js";

const approval = {
  sessionId: "session",
  jobId: "job",
  toolUse: { type: "tool-use" as const, id: "approval", name: "FileWrite", input: {} },
  reason: "requires approval"
};
const question = {
  sessionId: "session",
  jobId: "job",
  toolUse: { type: "tool-use" as const, id: "question", name: "AskUserQuestion", input: {} },
  question: {
    questions: [
      {
        question: "Proceed?",
        options: [
          { label: "Yes", description: "Proceed" },
          { label: "No", description: "Stop" }
        ]
      }
    ]
  }
};
const answer = {
  answers: [
    {
      question: "Proceed?",
      selectedLabels: ["No"],
      selectedOptions: [{ label: "No", description: "Stop" }]
    }
  ]
};

afterEach(() => vi.useRealTimers());

describe("interaction waiting", () => {
  it.each([undefined, 0])(
    "keeps approvals and questions pending for 48 hours with timeout %s",
    async (timeoutMs) => {
      vi.useFakeTimers();
      const registry = new ActiveInteractionRegistry({ timeoutMs });
      const onApproval = vi.fn();
      const onAnswer = vi.fn();
      const approvalWait = registry.waitForApproval(approval).then(onApproval);
      const questionWait = registry.waitForQuestion(question).then(onAnswer);
      await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
      expect(vi.getTimerCount()).toBe(0);
      expect(onApproval).not.toHaveBeenCalled();
      expect(onAnswer).not.toHaveBeenCalled();
      expect(registry.listInteractions({ status: "pending" })).toHaveLength(2);
      for (const interaction of registry.listInteractions()) {
        expect(interaction.timeoutAt).toBeUndefined();
      }
      registry.resolveApproval({ jobId: "job", toolUseId: "approval", approved: false });
      registry.resolveQuestion({ jobId: "job", toolUseId: "question", answer });
      await Promise.all([approvalWait, questionWait]);
      expect(onApproval).toHaveBeenCalledWith(false);
      expect(onAnswer).toHaveBeenCalledWith(answer);
      registry.close();
    }
  );

  it("accepts explicit approval after a long absence", async () => {
    vi.useFakeTimers();
    const registry = new ActiveInteractionRegistry();
    const wait = registry.waitForApproval(approval);
    await vi.advanceTimersByTimeAsync(86_400_000);
    registry.resolveApproval({ jobId: "job", toolUseId: "approval", approved: true });
    await expect(wait).resolves.toBe(true);
    registry.close();
  });

  it("preserves configured timeouts for approvals and questions", async () => {
    vi.useFakeTimers();
    const registry = new ActiveInteractionRegistry({ timeoutMs: 300_000 });
    const approvalResult = registry.waitForApproval(approval).catch((error) => error);
    const questionResult = registry.waitForQuestion(question).catch((error) => error);
    expect(registry.listInteractions()[0].timeoutAt).toBe(
      new Date(Date.now() + 300_000).toISOString()
    );
    await vi.advanceTimersByTimeAsync(299_999);
    expect(registry.listInteractions({ status: "pending" })).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await approvalResult).toBeInstanceOf(ActiveInteractionTimeoutError);
    expect(await questionResult).toBeInstanceOf(ActiveInteractionTimeoutError);
    expect(registry.listInteractions({ status: "timeout" })).toHaveLength(2);
    expect(() =>
      registry.resolveApproval({ jobId: "job", toolUseId: "approval", approved: true })
    ).toThrow();
    registry.close();
  });

  it("allows a per-interaction zero to override a finite default", async () => {
    vi.useFakeTimers();
    const registry = new ActiveInteractionRegistry({ timeoutMs: 10 });
    const wait = registry.waitForApproval({ ...approval, timeoutMs: 0 });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(registry.listInteractions({ status: "pending" })).toHaveLength(1);
    registry.resolveApproval({ jobId: "job", toolUseId: "approval", approved: false });
    await expect(wait).resolves.toBe(false);
    registry.close();
  });

  it.each(["cancel", "unregister", "close"])("ends unlimited waits on %s", async (action) => {
    const registry = new ActiveInteractionRegistry();
    const approvalResult = registry.waitForApproval(approval).catch((error) => error);
    const questionResult = registry.waitForQuestion(question).catch((error) => error);
    if (action === "cancel") {
      registry.cancelInteraction({ jobId: "job", toolUseId: "approval" });
      registry.cancelInteraction({ jobId: "job", toolUseId: "question" });
    } else if (action === "unregister") {
      registry.unregisterJob("job");
    } else {
      registry.close();
    }
    expect(await approvalResult).toBeInstanceOf(ActiveInteractionCancelledError);
    expect(await questionResult).toBeInstanceOf(ActiveInteractionCancelledError);
    expect(registry.listInteractions({ status: "pending" })).toHaveLength(0);
    registry.close();
  });

  it.each([
    [undefined, undefined],
    ["", undefined],
    ["0", 0],
    ["86400000", 86_400_000],
    ["2147483647", 2_147_483_647],
    ["2147483648", undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["invalid", undefined]
  ])("parses TUI timeout %s as %s", (raw, expected) => {
    expect(parseTuiInteractionTimeoutMs(raw as string | undefined)).toBe(expected);
  });
});
