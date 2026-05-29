import { describe, expect, it } from "vitest";

import { buildTuiRenderState, eventToTuiBlock } from "../src/tui/render-state.js";
import { renderTuiBlock, renderTuiState } from "../src/tui/renderer.js";
import { MagiEventView } from "../src/events.js";

function event(input: Partial<MagiEventView> & { id: number; action: string }): MagiEventView {
  return {
    sessionId: "session-render",
    eventName: input.action,
    category: "tool",
    status: "completed",
    createdAt: "2026-05-25T00:00:00.000Z",
    message: input.action,
    metadata: {},
    ...input
  };
}

describe("TUI render state and renderer", () => {
  it("builds block state from durable event views", () => {
    const state = buildTuiRenderState({
      sessionId: "session-render",
      model: "main",
      cwd: "/repo",
      events: [
        event({
          id: 1,
          action: "agent.tool.use",
          target: "FileRead",
          metadata: { id: "read-1" },
          status: "info"
        }),
        event({
          id: 2,
          action: "agent.approval.pending",
          category: "approval",
          status: "pending",
          target: "FileWrite",
          metadata: {
            interactionKind: "approval",
            toolUseId: "write-1",
            reason: "FileWrite requires approval"
          }
        })
      ]
    });

    expect(state.blocks.map((block) => block.title)).toContain("FileRead requested");
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]?.title).toBe("Approval waiting for FileWrite");
  });

  it("renders compact transcript blocks without color when requested", () => {
    const block = eventToTuiBlock(
      event({
        id: 3,
        action: "agent.tool.completed",
        target: "GitStatus",
        metadata: { toolCallId: "git-1" },
        status: "completed"
      })
    );

    expect(block).toBeDefined();
    expect(renderTuiBlock(block!, { color: false })).toBe("✓ GitStatus completed - (git-1)");
  });

  it("renders a bounded state summary and pending section", () => {
    const state = buildTuiRenderState({
      sessionId: "session-render-long",
      model: "main",
      cwd: "/repo",
      events: [
        event({
          id: 4,
          action: "agent.approval.pending",
          category: "approval",
          status: "pending",
          target: "Bash",
          metadata: {
            interactionKind: "approval",
            toolUseId: "bash-1",
            reason: "Bash requires approval"
          }
        })
      ]
    });
    const rendered = renderTuiState(state, { color: false, width: 60 });

    expect(rendered).toContain("Magi · model main · session session-… · /repo");
    expect(rendered).toContain("Pending: 1");
    expect(rendered).toContain("Approval waiting for Bash");
    for (const line of rendered.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });
});
