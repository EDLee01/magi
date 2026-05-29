import { describe, expect, it } from "vitest";

import {
  formatPlanReview,
  formatPlanReviewList,
  getLatestPlanReview,
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
});
