import { describe, expect, it } from "vitest";

import {
  filterMemoryHitsByRecallEvidence,
  planRecall,
  scoreSkillForRecall,
  selectHotMemoryNodes
} from "../src/agent/recall-policy.js";
import type { MemoryNode } from "../src/memory-node-store.js";

describe("recall policy", () => {
  it("does not turn negated source mentions into hard constraints", () => {
    const decision = planRecall({
      prompt: "修复这个 bug，不要读取历史记忆，不要调用 skills",
      cwd: "/Users/ktz/magi-next",
      hasMemory: true,
      hasSkills: true
    });

    expect(decision).toMatchObject({
      taskKind: "coding",
      budgets: {
        hotMemory: 3,
        memorySearch: 0,
        session: 0,
        skill: 1
      },
      constraints: []
    });
    expect(decision.reasons.hotMemory).toEqual(["global hot memory is enabled by default"]);
    expect(decision.reasons.memorySearch).toEqual([]);
    expect(decision.reasons.session).toEqual([]);
    expect(decision.reasons.skill).toEqual([
      "coding task can use high-confidence skill-name matches"
    ]);
  });

  it("does not use cwd or project path matches as dynamic recall evidence by default", () => {
    const decision = planRecall({
      prompt:
        "修复 /Users/ktz/magi-next/src/agent/recall-policy.ts 这个 bug，不要读取历史记忆，不要调用 skills",
      cwd: "/Users/ktz/magi-next",
      hasMemory: true,
      hasSkills: true
    });

    expect(decision.budgets).toEqual({
      hotMemory: 3,
      memorySearch: 0,
      session: 0,
      skill: 0
    });
    expect(decision.constraints).toEqual([]);
    expect(decision.reasons.hotMemory).toEqual(["global hot memory is enabled by default"]);
    expect(decision.reasons.memorySearch).toEqual([]);
  });

  it("does not treat ordinary project or workflow negation as positive recall evidence", () => {
    const decision = planRecall({
      prompt: "修复这个 bug，不要修改项目里的其它文件，也不要改 workflow 文档",
      cwd: "/Users/ktz/magi-next",
      hasMemory: true,
      hasSkills: true
    });

    expect(decision.constraints).toEqual([]);
    expect(decision.budgets).toEqual({
      hotMemory: 3,
      memorySearch: 0,
      session: 0,
      skill: 1
    });
  });

  it("allows a positive skill allowance without enabling dynamic memory recall", () => {
    const decision = planRecall({
      prompt:
        "检查 /Users/ktz/magi-next 里最近的改动风险，不要读取历史记忆，不要召回 prior sessions，不要注入 hot memory。可以使用一个明确相关的 code-review / review 类 skill，如果存在。不要因为我提到 skill 就加载全部 skills。",
      cwd: "/Users/ktz",
      hasMemory: true,
      hasSkills: true
    });

    expect(decision.constraints).toEqual([]);
    expect(decision.budgets).toEqual({
      hotMemory: 3,
      memorySearch: 0,
      session: 0,
      skill: 3
    });
    expect(decision.reasons.skill).toEqual(["prompt has explicit skill or workflow intent"]);
  });

  it("treats explicit Chinese memory questions as dynamic SQL memory-search intent", () => {
    const decision = planRecall({
      prompt: "我们公众号的推文你还记得怎么做么",
      cwd: "/Users/ktz/magi-next",
      hasMemory: true,
      hasSkills: true
    });

    expect(decision.taskKind).toBe("memory_dependent");
    expect(decision.budgets.memorySearch).toBeGreaterThan(0);
    expect(decision.matchedTerms.memorySearch).toContain("还记得");
  });

  it("treats named workflow references as dynamic memory-search intent", () => {
    const decision = planRecall({
      prompt: "Nature公众号推文工作流 这个",
      cwd: "/Users/ktz/magi-next",
      hasMemory: true,
      hasSkills: true
    });

    expect(decision.budgets.memorySearch).toBeGreaterThan(0);
    expect(decision.matchedTerms.memorySearch).toContain("工作流");
  });

  it("treats English remember-previous-workflow prompts as dynamic memory-search intent", () => {
    const decision = planRecall({
      prompt: "do you remember the previous workflow",
      cwd: "/Users/ktz/magi-next",
      hasMemory: true,
      hasSkills: true
    });

    expect(decision.budgets.memorySearch).toBeGreaterThan(0);
    expect(decision.matchedTerms.memorySearch).toEqual(
      expect.arrayContaining(["previous", "remember", "workflow"])
    );
  });

  it("keeps project memories out of global hot memory even when prompt terms overlap", () => {
    const selection = selectHotMemoryNodes({
      prompt: "你知道 Magi Next 吗",
      cwd: "/Users/ktz/magi-next",
      budget: 3,
      nodes: [
        memoryNode({
          type: "project",
          title: "GeoMind Next project memory",
          summary: "GeoMind Next is a later development focus.",
          body: "GeoMind Next project details should not affect unrelated Magi sessions.",
          weight: 1
        }),
        memoryNode({
          type: "preference",
          title: "Magi identity preference",
          summary: "User prefers Magi identity context to stay available.",
          body: "User prefers Magi identity context to stay available.",
          weight: 1
        })
      ]
    });

    expect(selection.nodes.map((node) => node.title)).toEqual(["Magi identity preference"]);
    expect(selection.skipped).toContainEqual(
      expect.objectContaining({
        title: "GeoMind Next project memory",
        type: "project",
        reason:
          "global hot memory only includes durable user profile, preference, or work habit nodes"
      })
    );
  });

  it("does not use weak shared terms as dynamic memory-search evidence", () => {
    const hits = filterMemoryHitsByRecallEvidence(
      [
        {
          file: "memdir/project_geomind_next.md",
          title: "GeoMind Next project memory",
          snippet: "GeoMind Next project details should not affect unrelated Magi sessions."
        },
        {
          file: "projects/magi-next.md",
          title: "Magi Next project memory",
          snippet: "Magi Next is the active CLI project."
        }
      ],
      "继续做 Magi Next",
      "/Users/ktz"
    );

    expect(hits.map((hit) => hit.title)).toEqual(["Magi Next project memory"]);
  });

  it("keeps user preference memory for explicit personal recall questions", () => {
    const hits = filterMemoryHitsByRecallEvidence(
      [
        {
          file: "user.md#User",
          title: "User",
          snippet: "User prefers focused CLI black-box verification for complex Magi work."
        },
        {
          file: "projects/default.md#Project: Default",
          title: "Project: Default",
          snippet: "Run focused CLI E2E before internal unit tests for Magi changes."
        }
      ],
      "What should you remember about my verification preference?",
      "/Users/ktz/magi-next"
    );

    expect(hits.map((hit) => hit.title)).toEqual(["User"]);
  });

  it("keeps Chinese SQL graph workflow hits with recall evidence", () => {
    const hits = filterMemoryHitsByRecallEvidence(
      [
        {
          file: "graph/memory-node",
          title: "Nature公众号推文工作流",
          snippet: "用户做 Nature 论文中文推文的标准提示词、模板位置和完整工作流程"
        }
      ],
      "我们公众号的推文你还记得怎么做么",
      "/Users/ktz/magi-next"
    );

    expect(hits.map((hit) => hit.title)).toEqual(["Nature公众号推文工作流"]);
  });

  it("scores a direct skill-name mention as a strong match even without skill keywords", () => {
    const verify = {
      name: "verify",
      summary: "Verify implementation",
      root: "/skills/verify",
      body: "# Verify\n"
    };
    // This prompt names the skill but trips neither SKILL_TERMS nor a clean
    // coding classification (it reads as memory_dependent), so planRecall gives
    // skill budget 0. The score must still be strong (>=12, a direct name match)
    // so buildSkillRecallContext can inject it despite the zero classifier budget
    // — the fix for the "sometimes injected, sometimes not" flakiness.
    const prompt = "verify 我对这个仓库的改动是否可用,按 verify 流程给结论";
    const hit = scoreSkillForRecall(verify, prompt);
    expect(hit?.score).toBeGreaterThanOrEqual(12);
    expect(hit?.matchedTerms).toContain("verify");

    // Guard against over-injection: an unrelated prompt scores nothing.
    expect(scoreSkillForRecall(verify, "今天天气怎么样")).toBeUndefined();
  });
});

function memoryNode(input: {
  type: MemoryNode["type"];
  title: string;
  summary: string;
  body: string;
  weight: number;
}): MemoryNode {
  const now = "2026-06-01T00:00:00.000Z";
  return {
    id: input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    type: input.type,
    title: input.title,
    summary: input.summary,
    body: input.body,
    weight: input.weight,
    status: "active",
    source: "test",
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    metadata: {}
  };
}
