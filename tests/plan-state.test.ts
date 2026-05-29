import { describe, expect, it } from "vitest";

import {
  adoptPlanReview,
  formatPlanReview,
  formatPlanReviewList,
  getLatestPlanReview,
  getPlanReviewChain,
  listPlanReviews,
  recordPlanReview,
  updatePlanReviewStatus
} from "../src/plan-state.js";
import { getMagiPaths } from "../src/paths.js";
import { makeTempRoot } from "./helpers.js";

describe("plan review state", () => {
  it("records, updates, lists, and formats submitted plans", () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const first = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "session-1",
        jobId: "job-1",
        toolUseId: "exit-plan-1",
        plan: "1. Inspect\n2. Implement"
      });
      recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "session-2",
        plan: "Other session"
      });

      expect(first.status).toBe("submitted");
      const approved = updatePlanReviewStatus(paths.stateRoot, first.id, {
        status: "approved",
        response: "Yes, proceed"
      });
      expect(approved).toMatchObject({ status: "approved", response: "Yes, proceed" });

      const sessionPlans = listPlanReviews(paths.stateRoot, "session-1");
      expect(sessionPlans).toHaveLength(1);
      expect(getLatestPlanReview(paths.stateRoot, "session-1")?.id).toBe(first.id);
      expect(formatPlanReview(sessionPlans[0])).toContain("Status: approved");
      expect(formatPlanReview(sessionPlans[0])).toContain("Implementation plan:");
      expect(formatPlanReviewList(sessionPlans)).toContain("Submitted plans:");
    } finally {
      temp.cleanup();
    }
  });

  it("tracks plan revision chains and formats their links", () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const original = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "session-chain",
        toolUseId: "exit-plan-original",
        plan: "1. Edit first\n2. Verify later",
        status: "needs_revision",
        response: "No, revise"
      });
      const revised = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "session-chain",
        toolUseId: "exit-plan-revised",
        plan: "1. Inspect first\n2. Edit\n3. Verify",
        status: "approved",
        response: "Yes, proceed",
        revisesPlanId: original.id
      });

      const plans = listPlanReviews(paths.stateRoot, "session-chain");
      expect(plans).toEqual([
        expect.objectContaining({
          id: revised.id,
          revisesPlanId: original.id,
          rootPlanId: original.id
        }),
        expect.objectContaining({
          id: original.id,
          revisedByPlanId: revised.id
        })
      ]);
      expect(formatPlanReview(plans[0])).toContain(`Revises plan: ${original.id}`);
      expect(formatPlanReview(plans[0])).toContain(`Root plan: ${original.id}`);
      expect(formatPlanReviewList(plans)).toContain(`revises:${original.id}`);
      expect(formatPlanReviewList(plans)).toContain(`revised-by:${revised.id}`);
      expect(getPlanReviewChain(paths.stateRoot, revised.id).map((plan) => plan.id)).toEqual([
        original.id,
        revised.id
      ]);
    } finally {
      temp.cleanup();
    }
  });

  it("adopts approved plans across sessions", () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const source = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "source-session",
        plan: "1. Inspect source\n2. Implement target",
        status: "approved",
        response: "Yes, proceed"
      });
      const adopted = adoptPlanReview({
        stateRoot: paths.stateRoot,
        sourcePlanId: source.id,
        targetSessionId: "target-session"
      });

      expect(adopted).toMatchObject({
        sessionId: "target-session",
        status: "approved",
        plan: source.plan,
        adoptedFromPlanId: source.id,
        adoptedFromSessionId: "source-session"
      });
      expect(formatPlanReview(adopted)).toContain(`Adopted from plan: ${source.id}`);
      expect(formatPlanReviewList(listPlanReviews(paths.stateRoot, "target-session"))).toContain(
        `adopted-from:${source.id}`
      );
    } finally {
      temp.cleanup();
    }
  });
});
