import { describe, expect, it } from "vitest";

import {
  adoptPlanReview,
  formatPlanReview,
  formatPlanReviewList,
  getLatestPlanReview,
  getPlanReviewChain,
  listPlanReviews,
  mergePlanReviews,
  recordPlanReview,
  resolvePlanReviewConflicts,
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

  it("rejects adopting over an active target plan unless forced", () => {
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
      const target = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "target-session",
        plan: "1. Preserve target plan",
        status: "approved",
        response: "Yes, proceed"
      });

      expect(() =>
        adoptPlanReview({
          stateRoot: paths.stateRoot,
          sourcePlanId: source.id,
          targetSessionId: "target-session"
        })
      ).toThrow("already has an approved or submitted plan");

      expect(getLatestPlanReview(paths.stateRoot, "target-session")?.id).toBe(target.id);

      const forced = adoptPlanReview({
        stateRoot: paths.stateRoot,
        sourcePlanId: source.id,
        targetSessionId: "target-session",
        force: true
      });

      expect(forced).toMatchObject({
        sessionId: "target-session",
        status: "approved",
        adoptedFromPlanId: source.id
      });
      expect(getLatestPlanReview(paths.stateRoot, "target-session")?.id).toBe(forced.id);
    } finally {
      temp.cleanup();
    }
  });

  it("merges approved plans across sessions and protects active targets", () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const alpha = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "alpha-session",
        plan: "1. Read alpha source\n2. Patch alpha target",
        status: "approved",
        response: "Yes, proceed"
      });
      const beta = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "beta-session",
        plan: "1. Read beta source\n2. Patch beta target",
        status: "approved",
        response: "Yes, proceed"
      });

      const merged = mergePlanReviews({
        stateRoot: paths.stateRoot,
        sourcePlanIds: [alpha.id, beta.id],
        targetSessionId: "merged-session"
      });

      expect(merged).toMatchObject({
        sessionId: "merged-session",
        status: "approved",
        mergedFromPlanIds: [alpha.id, beta.id],
        mergedFromSessionIds: ["alpha-session", "beta-session"]
      });
      expect(merged.plan).toContain("Merged implementation plan from 2 approved plans.");
      expect(merged.plan).toContain("Compatible steps:");
      expect(merged.plan).toContain("Read alpha source");
      expect(merged.plan).toContain("Patch alpha target");
      expect(merged.plan).toContain("Read beta source");
      expect(merged.plan).toContain("Patch beta target");
      expect(formatPlanReview(merged)).toContain(`Merged from plans: ${alpha.id}, ${beta.id}`);
      expect(formatPlanReview(merged)).toContain(
        "Merged from sessions: alpha-session, beta-session"
      );
      expect(formatPlanReviewList(listPlanReviews(paths.stateRoot, "merged-session"))).toContain(
        `merged-from:${alpha.id},${beta.id}`
      );

      const target = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "busy-session",
        plan: "1. Existing target plan",
        status: "submitted"
      });
      expect(() =>
        mergePlanReviews({
          stateRoot: paths.stateRoot,
          sourcePlanIds: [alpha.id, beta.id],
          targetSessionId: "busy-session"
        })
      ).toThrow("already has an approved or submitted plan");
      expect(getLatestPlanReview(paths.stateRoot, "busy-session")?.id).toBe(target.id);

      const forced = mergePlanReviews({
        stateRoot: paths.stateRoot,
        sourcePlanIds: [alpha.id, beta.id],
        targetSessionId: "busy-session",
        force: true
      });
      expect(forced.mergedFromPlanIds).toEqual([alpha.id, beta.id]);
      expect(getLatestPlanReview(paths.stateRoot, "busy-session")?.id).toBe(forced.id);
    } finally {
      temp.cleanup();
    }
  });

  it("marks merged plans needing revision when source plans conflict on a target", () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const alpha = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "alpha-session",
        plan: "1. Read shared config\n2. Patch src/config.ts to use alpha endpoint",
        status: "approved",
        response: "Yes, proceed"
      });
      const beta = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "beta-session",
        plan: "1. Read shared config\n2. Patch src/config.ts to use beta endpoint",
        status: "approved",
        response: "Yes, proceed"
      });

      const merged = mergePlanReviews({
        stateRoot: paths.stateRoot,
        sourcePlanIds: [alpha.id, beta.id],
        targetSessionId: "conflict-session"
      });

      expect(merged.status).toBe("needs_revision");
      expect(merged.response).toContain("needs revision");
      expect(merged.mergeConflicts).toEqual([
        {
          target: "src/config.ts",
          steps: [
            {
              planId: alpha.id,
              sessionId: "alpha-session",
              step: "Patch src/config.ts to use alpha endpoint"
            },
            {
              planId: beta.id,
              sessionId: "beta-session",
              step: "Patch src/config.ts to use beta endpoint"
            }
          ]
        }
      ]);
      expect(merged.plan).toContain("Merge conflicts requiring revision:");
      expect(merged.plan).toContain("Target: src/config.ts");
      expect(merged.plan).toContain("Patch src/config.ts to use alpha endpoint");
      expect(merged.plan).toContain("Patch src/config.ts to use beta endpoint");
      expect(formatPlanReview(merged)).toContain("Status: needs_revision");
      expect(formatPlanReview(merged)).toContain("Merge conflicts: 1");
      expect(formatPlanReviewList(listPlanReviews(paths.stateRoot, "conflict-session"))).toContain(
        "merge-conflicts:1"
      );
    } finally {
      temp.cleanup();
    }
  });

  it("resolves merge conflicts into an approved revision", () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const alpha = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "alpha-session",
        plan: "1. Read shared config\n2. Patch src/config.ts to use alpha endpoint",
        status: "approved",
        response: "Yes, proceed"
      });
      const beta = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId: "beta-session",
        plan: "1. Read shared config\n2. Patch src/config.ts to use beta endpoint",
        status: "approved",
        response: "Yes, proceed"
      });
      const conflicted = mergePlanReviews({
        stateRoot: paths.stateRoot,
        sourcePlanIds: [alpha.id, beta.id],
        targetSessionId: "conflict-session"
      });

      const resolved = resolvePlanReviewConflicts({
        stateRoot: paths.stateRoot,
        conflictedPlanId: conflicted.id,
        choicePlanId: beta.id
      });

      expect(resolved).toMatchObject({
        sessionId: "conflict-session",
        status: "approved",
        revisesPlanId: conflicted.id,
        rootPlanId: conflicted.id,
        resolvedFromPlanId: conflicted.id,
        resolvedChoicePlanId: beta.id,
        resolvedConflictTargets: ["src/config.ts"]
      });
      expect(resolved.plan).toContain(`Resolved merged implementation plan from ${conflicted.id}.`);
      expect(resolved.plan).toContain("Patch src/config.ts to use beta endpoint");
      expect(resolved.plan).not.toContain("Patch src/config.ts to use alpha endpoint");
      expect(formatPlanReview(resolved)).toContain(`Resolved from plan: ${conflicted.id}`);
      expect(formatPlanReview(resolved)).toContain(`Resolved with choice plan: ${beta.id}`);
      expect(formatPlanReviewList(listPlanReviews(paths.stateRoot, "conflict-session"))).toContain(
        `resolved-from:${conflicted.id}`
      );
      expect(getPlanReviewChain(paths.stateRoot, resolved.id).map((plan) => plan.id)).toEqual([
        conflicted.id,
        resolved.id
      ]);
    } finally {
      temp.cleanup();
    }
  });
});
