#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const reportPath =
  process.env.MAGI_GOAL_PLAN_EVAL_REPORT ??
  path.join(repoRoot, ".magi-reports", "goal-plan-eval.json");
const startedAt = new Date();

const root = process.env.MAGI_KEEP_GOAL_PLAN_EVAL_TMP
  ? mkdtempSync(path.join(os.tmpdir(), "magi-goal-plan-eval-keep-"))
  : mkdtempSync(path.join(os.tmpdir(), "magi-goal-plan-eval-"));
const configDir = path.join(root, "config");
const workDir = path.join(root, "work");
const sessionId = "goal-plan-eval-session";
const secondSessionId = "goal-plan-eval-second-session";
const adoptedSessionId = "goal-plan-eval-adopted-session";
const parallelAlphaSessionId = "goal-plan-eval-parallel-alpha";
const parallelBetaSessionId = "goal-plan-eval-parallel-beta";
const parallelAdoptSessionId = "goal-plan-eval-parallel-adopt";
const mergedPlanSessionId = "goal-plan-eval-merged-plan";
const conflictAlphaSessionId = "goal-plan-eval-conflict-alpha";
const conflictBetaSessionId = "goal-plan-eval-conflict-beta";
const conflictMergeSessionId = "goal-plan-eval-conflict-merge";
const activeGoalObjective = "inspect Goal/Plan lifecycle eval context";
const blockedGoalObjective = "wait for Goal/Plan blocked audit";
const completedGoalObjective = "complete Goal/Plan lifecycle eval";
const deniedWritePath = "blocked-plan-write.txt";
const planText = [
  "1. Inspect goal and plan state",
  "2. Verify mutation denial before implementation",
  "3. Persist the plan review before editing"
].join("\n");
const firstRevisionPlanText = ["1. Edit immediately", "2. Verify later"].join("\n");
const secondRevisionPlanText = [
  "1. Inspect feedback",
  "2. Edit inherited-plan-output.txt",
  "3. Verify later"
].join("\n");
const approvedPlanText = [
  "1. Inspect the plan feedback",
  "2. Read migration-source.txt before editing migration-target.txt",
  "3. Patch migration-target.txt to the migrated policy",
  "4. Re-read migration-target.txt after patching",
  "5. Write inherited-plan-output.txt only after migration-target.txt is migrated"
].join("\n");
const parallelAlphaPlanText = [
  "1. Read alpha-source.txt",
  "2. Patch alpha-target.txt",
  "3. Verify alpha result"
].join("\n");
const parallelBetaPlanText = [
  "1. Read beta-source.txt",
  "2. Patch beta-target.txt",
  "3. Verify beta result"
].join("\n");
const conflictAlphaPlanText = [
  "1. Read src/config.ts",
  "2. Patch src/config.ts to use alpha endpoint"
].join("\n");
const conflictBetaPlanText = [
  "1. Read src/config.ts",
  "2. Patch src/config.ts to use beta endpoint"
].join("\n");
const inheritedPlanSourcePath = "inherited-plan-source.txt";
const inheritedPlanOutputPath = "inherited-plan-output.txt";
const inheritedPlanSourceContent = "source inspected before inherited plan write\n";
const inheritedPlanOutputContent = "inherited plan executed after read\n";
const migrationSourcePath = "migration-source.txt";
const migrationTargetPath = "migration-target.txt";
const migrationSourceContent = "migration source: move legacy policy to migrated policy\n";
const migrationTargetBefore = "status: legacy\nsource: old-policy\n";
const migrationTargetAfter = "status: migrated\nsource: migration-source\n";

let harnessReport;

try {
  assert(existsSync(cliPath), "dist/cli.js does not exist. Run npm run build first.");
  harnessReport = await import("../dist/harness-report.js");
  const tools = await import("../dist/tools/registry.js");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const state = {
    activeGoalContextSeen: false,
    completedGoalSuppressed: false,
    blockedGoalSuppressed: false,
    writeDeniedInPlanMode: false,
    planSubmittedToModel: false,
    inheritedPlanContextSeen: false,
    inheritedPlanReadBeforeWrite: false,
    inheritedPlanExecutionCompleted: false,
    inheritedPlanDeviationCorrected: false,
    crossSessionPlanAdopted: false,
    crossSessionAdoptedPlanContextSeen: false,
    blockedGoalPersisted: false,
    repeatedPlanDeviationBlocked: false,
    multiStepPlanDeviationRecovered: false,
    migrationPlanExecutionVerified: false,
    parallelPlanIsolationSeen: false,
    parallelPlanConflictRejected: false,
    parallelPlanAdoptedExplicitly: false,
    mergedPlanContextSeen: false,
    conflictedMergeContextSeen: false
  };
  const provider = await startProvider({ routeRequest: createRouter(state) });
  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderConfig({ port: provider.port }),
      "utf8"
    );
    writeFileSync(path.join(workDir, inheritedPlanSourcePath), inheritedPlanSourceContent, "utf8");
    writeFileSync(path.join(workDir, migrationSourcePath), migrationSourceContent, "utf8");
    writeFileSync(path.join(workDir, migrationTargetPath), migrationTargetBefore, "utf8");

    await runCli(
      ["--session-id", sessionId, "--model", "main", "-p", "Prepare Goal/Plan eval session."],
      "seed session"
    );
    const createdGoal = await runCli(
      ["goal", activeGoalObjective, "--session-id", sessionId],
      "goal start"
    );
    assert(
      createdGoal.includes(`Goal started: ${activeGoalObjective}`),
      "goal start did not confirm"
    );
    const goalStatus = await runCli(["goal", "--session-id", sessionId], "goal status active");
    assert(goalStatus.includes(`Goal: ${activeGoalObjective}`), "active goal was not visible");

    const activeContext = await runCli(
      [
        "--session-id",
        sessionId,
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        "Check active Goal/Plan eval context."
      ],
      "active goal context"
    );
    assert(activeContext.includes("Active goal context is present"), "active goal prompt failed");

    const planOutput = await runCli(
      [
        "--session-id",
        sessionId,
        "--permission-mode",
        "plan",
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        "Plan a risky Goal/Plan change before editing."
      ],
      "plan mode workflow"
    );
    assert(planOutput.includes("Goal/Plan eval plan submitted"), "plan mode final answer missing");
    assert(!existsSync(path.join(workDir, deniedWritePath)), "plan mode allowed a blocked write");

    const planStatus = await runCli(["plan", "--session-id", sessionId], "plan status");
    assert(planStatus.includes("Status: submitted"), "plan review was not persisted");
    assert(planStatus.includes("Verify mutation denial"), "plan review missed plan content");
    const planList = await runCli(["plan", "list", "--session-id", sessionId], "plan list");
    assert(planList.includes("Submitted plans:"), "plan list did not show submitted plans");
    assert(planList.includes("submitted"), "plan list did not include submitted status");
    await runCli(
      [
        "--session-id",
        secondSessionId,
        "--model",
        "main",
        "-p",
        "Prepare second Goal/Plan eval session."
      ],
      "seed second session"
    );
    const scopedSecondPlanList = await runCli(
      ["plan", "list", "--session-id", secondSessionId],
      "second session scoped plan list"
    );
    assert(
      scopedSecondPlanList.includes("No submitted plans."),
      "second session unexpectedly saw first session plan"
    );
    const crossSessionPlanList = await runCli(["plan", "all"], "cross-session plan list");
    assert(
      crossSessionPlanList.includes("Submitted plans:"),
      "plan all did not list submitted plans"
    );
    assert(crossSessionPlanList.includes("submitted"), "plan all missed submitted status");
    assert(
      crossSessionPlanList.includes("Inspect goal and plan state"),
      "plan all missed first plan"
    );

    const blockedGoal = await runCli(
      ["goal", blockedGoalObjective, "--session-id", sessionId],
      "blocked goal start"
    );
    assert(
      blockedGoal.includes(`Goal started: ${blockedGoalObjective}`),
      "blocked goal start did not confirm"
    );
    const blocked = await runCli(
      ["goal", "blocked", "waiting on external review", "--session-id", sessionId],
      "goal blocked"
    );
    assert(blocked.includes(`Goal blocked: ${blockedGoalObjective}`), "goal blocked failed");
    const blockedStatus = await runCli(["goal", "--session-id", sessionId], "goal status blocked");
    assert(blockedStatus.includes("No active goal"), "blocked goal stayed active");
    const blockedList = await runCli(["goal", "list", "--session-id", sessionId], "goal list");
    assert(blockedList.includes("blocked"), "goal list missed blocked status");
    assert(blockedList.includes(blockedGoalObjective), "goal list missed blocked objective");
    const blockedContext = await runCli(
      [
        "--session-id",
        sessionId,
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        "Verify blocked goal is no longer injected."
      ],
      "blocked goal context"
    );
    assert(
      blockedContext.includes("Blocked goal is no longer injected"),
      "blocked goal prompt failed"
    );

    const newGoal = await runCli(
      ["goal", completedGoalObjective, "--session-id", sessionId],
      "completion goal start"
    );
    assert(
      newGoal.includes(`Goal started: ${completedGoalObjective}`),
      "completion goal start failed"
    );
    const completed = await runCli(
      ["goal", "done", "verified by goal-plan eval", "--session-id", sessionId],
      "goal done"
    );
    assert(
      completed.includes(`Goal completed: ${completedGoalObjective}`),
      "goal completion failed"
    );
    const inactiveGoalStatus = await runCli(
      ["goal", "--session-id", sessionId],
      "goal status completed"
    );
    assert(inactiveGoalStatus.includes("No active goal"), "completed goal stayed active");

    const inactiveContext = await runCli(
      [
        "--session-id",
        sessionId,
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        "Verify completed goal is no longer injected."
      ],
      "completed goal context"
    );
    assert(
      inactiveContext.includes("Completed goal is no longer injected"),
      "completed goal prompt failed"
    );

    const goalCompleted = assertGoalStoreCompleted();
    const blockedGoalPersisted = assertGoalStoreBlocked();
    state.blockedGoalPersisted = blockedGoalPersisted;
    const planReviewPersisted = assertPlanStoreSubmitted();
    const crossSessionPlanReviewListed = true;
    const planRevision = await runPlanRevisionApprovalFlow(tools.executeRegisteredTool);
    const planRevisionPersisted = assertPlanStoreRevisionPersisted(planRevision.revisionPlanId);
    const secondPlanRevisionPersisted = assertPlanStoreSecondRevisionPersisted(
      planRevision.secondRevisionPlanId
    );
    const planApprovalPersisted = assertPlanStoreApprovalPersisted(planRevision.approvedPlanId);
    const parallelPlans = await runParallelPlanConflictFlow(tools.executeRegisteredTool);
    const mergedPlans = await runMergedPlanFlow(parallelPlans.alphaPlanId, parallelPlans.betaPlanId);
    const conflictedMerge = await runConflictedMergeFlow(tools.executeRegisteredTool);
    const planRevisionChainLinked = assertPlanRevisionChainLinked(
      planRevision.revisionPlanId,
      planRevision.secondRevisionPlanId,
      planRevision.approvedPlanId
    );
    const planRevisionChainViewListed = await assertPlanRevisionChainViewListed(
      planRevision.revisionPlanId,
      planRevision.secondRevisionPlanId,
      planRevision.approvedPlanId
    );
    const inheritedPlanContext = await runCli(
      [
        "--session-id",
        sessionId,
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        "Verify inherited plan context is injected."
      ],
      "inherited plan context"
    );
    assert(
      inheritedPlanContext.includes("Inherited plan context is present"),
      "inherited plan context prompt failed"
    );
    const inheritedPlanExecution = await runCli(
      [
        "--session-id",
        sessionId,
        "--permission-mode",
        "acceptEdits",
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        "Execute inherited plan using the persisted order."
      ],
      "inherited plan execution"
    );
    assert(
      inheritedPlanExecution.includes("Inherited plan execution complete"),
      "inherited plan execution final answer missing"
    );
    const inheritedPlanExecutionFollowed = assertInheritedPlanExecutionFollowed();
    const crossSessionPlanAdopted = await assertCrossSessionPlanAdopted(
      planRevision.approvedPlanId
    );
    const adoptedPlanContext = await runCli(
      [
        "--session-id",
        adoptedSessionId,
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        "Verify adopted cross-session plan context is injected."
      ],
      "adopted plan context"
    );
    assert(
      adoptedPlanContext.includes("Adopted cross-session plan context is present"),
      "adopted plan context prompt failed"
    );
    assert(state.activeGoalContextSeen, "provider did not see active goal context");
    assert(state.completedGoalSuppressed, "provider still saw completed goal context");
    assert(state.blockedGoalSuppressed, "provider still saw blocked goal context");
    assert(state.writeDeniedInPlanMode, "provider did not observe plan-mode write denial");
    assert(state.planSubmittedToModel, "provider did not observe submitted plan feedback");
    assert(state.inheritedPlanContextSeen, "provider did not see inherited plan context");
    assert(state.repeatedPlanDeviationBlocked, "provider did not hit repeated plan guard blocks");
    assert(state.inheritedPlanReadBeforeWrite, "provider did not read before mutation");
    assert(state.multiStepPlanDeviationRecovered, "provider did not perform multi-step recovery");
    assert(state.migrationPlanExecutionVerified, "provider did not verify migration execution");
    assert(state.inheritedPlanExecutionCompleted, "provider did not complete inherited plan");
    assert(state.inheritedPlanDeviationCorrected, "provider did not correct plan deviation");
    assert(state.parallelPlanIsolationSeen, "provider did not see isolated parallel plan contexts");
    assert(state.mergedPlanContextSeen, "provider did not see merged plan context");
    assert(state.conflictedMergeContextSeen, "provider did not see conflicted merge context");
    assert(state.crossSessionAdoptedPlanContextSeen, "provider did not see adopted plan context");

    const toolCounts = mergeToolCounts(provider.metrics().toolCounts, planRevision.toolCounts);
    const assertions = [
      "active goal status visible in CLI",
      "active goal injected into model context",
      "plan mode denied FileWrite mutation",
      "submitted plan feedback returned to model",
      "plan review persisted in state",
      "scoped plan list isolated second session",
      "cross-session plan list included submitted plan",
      "blocked goal persisted in state",
      "blocked goal suppressed from context",
      "completed goal persisted with note",
      "completed goal suppressed from context",
      "revision feedback returned to tool caller",
      "first revision plan persisted as needs_revision",
      "second revision feedback returned to tool caller",
      "second revision plan persisted as needs_revision",
      "approved plan persisted as approved",
      "multi-round revision chain linked replacement plan",
      "multi-round revision chain visible from CLI",
      "inherited approved plan injected into context",
      "plan execution guard blocked early patch",
      "plan execution guard blocked second early write",
      "required migration source read result visible before mutation",
      "migration target patched after required read",
      "migration target re-read after patch",
      "inherited plan output written after migration verification",
      "approved plan adopted across sessions",
      "adopted plan context included source metadata",
      "parallel approved plans stayed isolated by session",
      "parallel conflicting plan was rejected without explicit adopt",
      "parallel approved plan adopted only when requested",
      "approved plans merged into an explicit target session",
      "merged plan context included all source metadata",
      "conflicting plan merge persisted as needs_revision",
      "conflicting merge context included conflict target and source steps"
    ];
    const filesVerified = [
      "state/goals.json",
      "state/plans.json",
      migrationSourcePath,
      migrationTargetPath,
      inheritedPlanOutputPath
    ];

    const report = harnessReport.buildHarnessReport({
      name: "goal-plan-eval",
      startedAt,
      scenarios: [
        {
          name: "goal-plan lifecycle workflow",
          status: "passed",
          durationMs: Date.now() - startedAt.getTime(),
          score: 1,
          failureKind: null,
          details: {
            provider: { callCount: provider.calls.length },
            toolCounts,
            assertions,
            filesVerified,
            activeGoalContextSeen: state.activeGoalContextSeen,
            completedGoalSuppressed: state.completedGoalSuppressed,
            blockedGoalSuppressed: state.blockedGoalSuppressed,
            writeDeniedInPlanMode: state.writeDeniedInPlanMode,
            planSubmittedToModel: state.planSubmittedToModel,
            planReviewPersisted,
            crossSessionPlanReviewListed,
            planRevisionFeedbackSeen: planRevision.revisionFeedbackSeen,
            planRevisionPersisted,
            multiRoundPlanFeedbackSeen: planRevision.multiRoundPlanFeedbackSeen,
            secondPlanRevisionPersisted,
            planApprovalSeen: planRevision.approvalSeen,
            planApprovalPersisted,
            planRevisionChainLinked,
            planRevisionChainViewListed,
            inheritedPlanContextSeen: state.inheritedPlanContextSeen,
            inheritedPlanExecutionFollowed,
            inheritedPlanDeviationCorrected: state.inheritedPlanDeviationCorrected,
            repeatedPlanDeviationBlocked: state.repeatedPlanDeviationBlocked,
            multiStepPlanDeviationRecovered: state.multiStepPlanDeviationRecovered,
            migrationPlanExecutionVerified: state.migrationPlanExecutionVerified,
            crossSessionPlanAdopted,
            crossSessionAdoptedPlanContextSeen: state.crossSessionAdoptedPlanContextSeen,
            parallelPlanIsolationSeen: state.parallelPlanIsolationSeen,
            parallelPlanConflictRejected: parallelPlans.conflictRejected,
            parallelPlanAdoptedExplicitly: parallelPlans.adoptedExplicitly,
            mergedPlanCreated: mergedPlans.mergedPlanCreated,
            mergedPlanContextSeen: state.mergedPlanContextSeen,
            conflictedMergeNeedsRevision: conflictedMerge.needsRevision,
            conflictedMergeContextSeen: state.conflictedMergeContextSeen,
            blockedGoalPersisted,
            goalCompleted
          }
        }
      ]
    });
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Goal/Plan eval passed (provider calls=${provider.calls.length}).`);
    console.log(`Goal/Plan report: ${reportPath}`);
  } finally {
    await provider.close();
  }
} finally {
  if (!process.env.MAGI_KEEP_GOAL_PLAN_EVAL_TMP) {
    rmSync(root, { recursive: true, force: true });
  }
}

function createRouter(state) {
  let planTurns = 0;
  let inheritedPlanExecutionTurns = 0;
  let deviationBlockCount = 0;
  return ({ latestUser, systemPrompt, transcript, toolNames }) => {
    if (latestUser.includes("Prepare Goal/Plan eval session")) {
      return messageText("Goal/Plan eval session ready.");
    }

    if (latestUser.includes("Check active Goal/Plan eval context")) {
      assert(systemPrompt.includes("<active_thread_goal>"), "active goal was not injected");
      assert(
        systemPrompt.includes(`Objective: ${activeGoalObjective}`),
        "active goal objective was not injected"
      );
      state.activeGoalContextSeen = true;
      return messageText("Active goal context is present.");
    }

    if (latestUser.includes("Plan a risky Goal/Plan change")) {
      planTurns += 1;
      if (planTurns === 1) {
        assert(systemPrompt.includes("<active_thread_goal>"), "plan mode missed active goal");
        assert(toolNames.includes("FileWrite"), "FileWrite was not exposed for permission denial");
        assert(toolNames.includes("ExitPlanMode"), "ExitPlanMode was not exposed");
        return toolResponse([
          toolCall("blocked-plan-write", "FileWrite", {
            file_path: deniedWritePath,
            content: "plan mode should block this write"
          })
        ]);
      }
      if (planTurns === 2) {
        assert(
          transcript.includes("FileWrite is not allowed in plan mode"),
          "plan mode denial was not returned to the model"
        );
        state.writeDeniedInPlanMode = true;
        return toolResponse([toolCall("submit-goal-plan", "ExitPlanMode", { plan: planText })]);
      }
      assert(
        transcript.includes("Plan submitted for user approval"),
        "ExitPlanMode did not surface submitted plan feedback"
      );
      assert(transcript.includes("Verify mutation denial"), "submitted plan text was not visible");
      state.planSubmittedToModel = true;
      return messageText("Goal/Plan eval plan submitted.");
    }

    if (latestUser.includes("Verify completed goal is no longer injected")) {
      assert(!systemPrompt.includes("<active_thread_goal>"), "completed goal was still injected");
      assert(
        !systemPrompt.includes(completedGoalObjective),
        "completed goal objective was still injected"
      );
      state.completedGoalSuppressed = true;
      return messageText("Completed goal is no longer injected.");
    }

    if (latestUser.includes("Verify blocked goal is no longer injected")) {
      assert(!systemPrompt.includes("<active_thread_goal>"), "blocked goal was still injected");
      assert(
        !systemPrompt.includes(blockedGoalObjective),
        "blocked goal objective was still injected"
      );
      state.blockedGoalSuppressed = true;
      return messageText("Blocked goal is no longer injected.");
    }

    if (latestUser.includes("Verify inherited plan context is injected")) {
      assert(systemPrompt.includes("<session_plan_context>"), "plan context was not injected");
      assert(
        systemPrompt.includes(approvedPlanText),
        "approved plan text was not injected into plan context"
      );
      assert(
        !systemPrompt.includes(firstRevisionPlanText) &&
          !systemPrompt.includes(secondRevisionPlanText),
        "superseded plan text leaked into latest plan context"
      );
      state.inheritedPlanContextSeen = true;
      return messageText("Inherited plan context is present.");
    }

    if (latestUser.includes("Execute inherited plan using the persisted order")) {
      inheritedPlanExecutionTurns += 1;
      assert(systemPrompt.includes("<session_plan_context>"), "execution missed plan context");
      assert(
        systemPrompt.includes(`Read ${migrationSourcePath} before editing ${migrationTargetPath}`),
        "execution missed read-before-write plan step"
      );
      assert(toolNames.includes("FileRead"), "FileRead was not available for inherited plan");
      assert(toolNames.includes("FileWrite"), "FileWrite was not available for inherited plan");
      assert(toolNames.includes("FilePatch"), "FilePatch was not available for inherited plan");
      if (inheritedPlanExecutionTurns === 1) {
        return toolResponse([
          toolCall("migration-patch-too-soon", "FilePatch", {
            file_path: migrationTargetPath,
            patch: [
              "@@",
              "-status: legacy",
              "-source: old-policy",
              "+status: migrated",
              "+source: migration-source"
            ].join("\n")
          })
        ]);
      }
      if (inheritedPlanExecutionTurns === 2) {
        assert(
          transcript.includes("Plan execution guard"),
          "first plan deviation guard feedback was not visible"
        );
        assert(
          transcript.includes(`Required first: FileRead ${migrationSourcePath}`),
          "first plan deviation guard did not name required migration read"
        );
        assert(
          readFileSync(path.join(workDir, migrationTargetPath), "utf8") === migrationTargetBefore,
          "plan deviation guard allowed early patch"
        );
        deviationBlockCount += 1;
        return toolResponse([
          toolCall("inherited-plan-write-too-soon", "FileWrite", {
            file_path: inheritedPlanOutputPath,
            content: inheritedPlanOutputContent
          })
        ]);
      }
      if (inheritedPlanExecutionTurns === 3) {
        assert(
          transcript.includes("Plan execution guard"),
          "second plan deviation guard feedback was not visible"
        );
        assert(
          transcript.includes(`Required first: FileRead ${migrationSourcePath}`),
          "second plan deviation guard did not preserve required migration read"
        );
        assert(
          !existsSync(path.join(workDir, inheritedPlanOutputPath)),
          "second plan deviation guard allowed early output write"
        );
        deviationBlockCount += 1;
        state.repeatedPlanDeviationBlocked = deviationBlockCount >= 2;
        state.inheritedPlanDeviationCorrected = true;
        return toolResponse([
          toolCall("migration-source-read", "FileRead", { file_path: migrationSourcePath })
        ]);
      }
      if (inheritedPlanExecutionTurns === 4) {
        assert(
          transcript.includes(migrationSourceContent.trim()),
          "migration source read result was not visible"
        );
        assert(
          !transcript.includes(`Wrote ${inheritedPlanOutputPath}`),
          "output was written before migration source read"
        );
        state.inheritedPlanReadBeforeWrite = true;
        return toolResponse([
          toolCall("migration-target-patch", "FilePatch", {
            file_path: migrationTargetPath,
            patch: [
              "@@",
              "-status: legacy",
              "-source: old-policy",
              "+status: migrated",
              "+source: migration-source"
            ].join("\n")
          })
        ]);
      }
      if (inheritedPlanExecutionTurns === 5) {
        assert(
          transcript.includes(`Patched ${migrationTargetPath}`),
          "migration target patch result was not visible"
        );
        assert(
          readFileSync(path.join(workDir, migrationTargetPath), "utf8") === migrationTargetAfter,
          "migration target file was not migrated"
        );
        return toolResponse([
          toolCall("migration-target-reread", "FileRead", { file_path: migrationTargetPath })
        ]);
      }
      if (inheritedPlanExecutionTurns === 6) {
        assert(
          transcript.includes("status: migrated"),
          "migration target re-read did not show migrated status"
        );
        assert(
          transcript.includes("source: migration-source"),
          "migration target re-read did not show migrated source"
        );
        state.multiStepPlanDeviationRecovered = true;
        state.migrationPlanExecutionVerified = true;
        return toolResponse([
          toolCall("inherited-plan-write-after-migration", "FileWrite", {
            file_path: inheritedPlanOutputPath,
            content: inheritedPlanOutputContent
          })
        ]);
      }
      assert(
        transcript.includes(`Wrote ${inheritedPlanOutputPath}`),
        "inherited plan write result was not visible"
      );
      state.inheritedPlanExecutionCompleted = true;
      return messageText("Inherited plan execution complete.");
    }

    if (latestUser.includes("Verify adopted cross-session plan context is injected")) {
      assert(systemPrompt.includes("<session_plan_context>"), "adopted plan context missing");
      assert(systemPrompt.includes(approvedPlanText), "adopted plan text was not injected");
      assert(
        systemPrompt.includes("Adopted from plan:"),
        "adopted plan context missed source plan"
      );
      assert(
        systemPrompt.includes(`Adopted from session: ${sessionId}`),
        "adopted plan context missed source session"
      );
      state.crossSessionAdoptedPlanContextSeen = true;
      return messageText("Adopted cross-session plan context is present.");
    }

    if (latestUser.includes("Verify parallel alpha plan context is isolated")) {
      assert(systemPrompt.includes("<session_plan_context>"), "parallel alpha plan context missing");
      assert(systemPrompt.includes(parallelAlphaPlanText), "parallel alpha plan text missing");
      assert(!systemPrompt.includes(parallelBetaPlanText), "parallel beta plan leaked into alpha");
      return messageText("Parallel alpha plan context is isolated.");
    }

    if (latestUser.includes("Verify parallel beta plan context is isolated")) {
      assert(systemPrompt.includes("<session_plan_context>"), "parallel beta plan context missing");
      assert(systemPrompt.includes(parallelBetaPlanText), "parallel beta plan text missing");
      assert(!systemPrompt.includes(parallelAlphaPlanText), "parallel alpha plan leaked into beta");
      state.parallelPlanIsolationSeen = true;
      return messageText("Parallel beta plan context is isolated.");
    }

    if (latestUser.includes("Verify explicitly adopted parallel plan context")) {
      assert(systemPrompt.includes("<session_plan_context>"), "parallel adopted context missing");
      assert(systemPrompt.includes(parallelAlphaPlanText), "adopted alpha plan text missing");
      assert(!systemPrompt.includes(parallelBetaPlanText), "unrequested beta plan leaked into adopt");
      assert(
        systemPrompt.includes(`Adopted from session: ${parallelAlphaSessionId}`),
        "parallel adopted context missed source session"
      );
      return messageText("Explicitly adopted parallel plan context is present.");
    }

    if (latestUser.includes("Verify merged parallel plan context")) {
      assert(systemPrompt.includes("<session_plan_context>"), "merged plan context missing");
      assert(systemPrompt.includes("Merged implementation plan from 2 approved plans."), "merged plan header missing");
      assert(systemPrompt.includes("Read alpha-source.txt"), "merged plan missed alpha read step");
      assert(systemPrompt.includes("Patch alpha-target.txt"), "merged plan missed alpha patch step");
      assert(systemPrompt.includes("Read beta-source.txt"), "merged plan missed beta read step");
      assert(systemPrompt.includes("Patch beta-target.txt"), "merged plan missed beta patch step");
      assert(
        systemPrompt.includes(`Merged from sessions: ${parallelAlphaSessionId}, ${parallelBetaSessionId}`),
        "merged plan context missed source sessions"
      );
      state.mergedPlanContextSeen = true;
      return messageText("Merged parallel plan context is present.");
    }

    if (latestUser.includes("Verify conflicted merged plan context")) {
      assert(systemPrompt.includes("<session_plan_context>"), "conflicted merge context missing");
      assert(systemPrompt.includes("Status: needs_revision"), "conflicted merge status missing");
      assert(systemPrompt.includes("Merge conflicts: 1"), "conflicted merge count missing");
      assert(systemPrompt.includes("Conflict target: src/config.ts"), "conflicted merge target missing");
      assert(
        systemPrompt.includes("Patch src/config.ts to use alpha endpoint"),
        "conflicted merge missed alpha step"
      );
      assert(
        systemPrompt.includes("Patch src/config.ts to use beta endpoint"),
        "conflicted merge missed beta step"
      );
      state.conflictedMergeContextSeen = true;
      return messageText("Conflicted merged plan context is present.");
    }

    return messageText("OK");
  };
}

async function startProvider({ routeRequest }) {
  const calls = [];
  const plannedToolCounts = {};
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const toolNames = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
        const call = {
          model: body.model,
          latestUser: latestUserFromBody(body),
          systemPrompt: systemPromptFromBody(body),
          transcript: transcriptFromBody(body),
          toolNames
        };
        calls.push(call);
        const result = routeRequest(call);
        const responseBody = result.body ?? result;
        for (const toolCall of responseBody.choices?.[0]?.message?.tool_calls ?? []) {
          plannedToolCounts[toolCall.function.name] =
            (plannedToolCounts[toolCall.function.name] ?? 0) + 1;
        }
        response.writeHead(result.status ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(responseBody));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: error instanceof Error ? error.message : String(error) }
          })
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object", "goal-plan eval provider did not bind");
  return {
    calls,
    port: address.port,
    metrics() {
      return {
        toolCounts: plannedToolCounts
      };
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function mergeToolCounts(...countsList) {
  const merged = {};
  for (const counts of countsList) {
    for (const [name, count] of Object.entries(counts ?? {})) {
      if (typeof count === "number" && Number.isFinite(count) && count > 0) {
        merged[name] = (merged[name] ?? 0) + count;
      }
    }
  }
  return merged;
}

function runCli(args, label, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "--no-color", ...args], {
      cwd: workDir,
      env: {
        ...process.env,
        MAGI_CONFIG_DIR: configDir,
        MAGI_OPENAI_API_KEY: "test-key",
        NO_COLOR: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `${label} timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `${label} failed with exit ${code ?? signal}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      resolve(stdout);
    });
  });
}

function assertGoalStoreCompleted() {
  const goals = JSON.parse(readFileSync(path.join(configDir, "state", "goals.json"), "utf8")).goals;
  const goal = goals.find((candidate) => candidate.objective === completedGoalObjective);
  assert(goal, "goal record was not persisted");
  assert(goal.status === "completed", "goal record was not completed");
  assert(goal.completedAt, "goal record missed completedAt");
  assert(goal.note === "verified by goal-plan eval", "goal record missed completion note");
  return true;
}

function assertGoalStoreBlocked() {
  const goals = JSON.parse(readFileSync(path.join(configDir, "state", "goals.json"), "utf8")).goals;
  const goal = goals.find((candidate) => candidate.objective === blockedGoalObjective);
  assert(goal, "blocked goal record was not persisted");
  assert(goal.status === "blocked", "blocked goal record was not blocked");
  assert(goal.blockedAt, "blocked goal record missed blockedAt");
  assert(goal.note === "waiting on external review", "blocked goal record missed blocked note");
  return true;
}

function assertPlanStoreSubmitted() {
  const plans = JSON.parse(readFileSync(path.join(configDir, "state", "plans.json"), "utf8")).plans;
  const plan = plans.find((candidate) => candidate.plan === planText);
  assert(plan, "plan review record was not persisted");
  assert(plan.sessionId === sessionId, "plan review used the wrong session");
  assert(plan.status === "submitted", "headless plan review should remain submitted");
  assert(plan.toolUseId === "submit-goal-plan", "plan review missed the ExitPlanMode tool id");
  return true;
}

async function runPlanRevisionApprovalFlow(executeRegisteredTool) {
  const toolCounts = { ExitPlanMode: 3 };
  const firstRevision = await executeRegisteredTool({
    cwd: workDir,
    stateRoot: path.join(configDir, "state"),
    sessionId,
    toolUse: {
      type: "tool-use",
      id: "revise-goal-plan-first",
      name: "ExitPlanMode",
      input: { plan: firstRevisionPlanText }
    },
    userQuestionResolver: ({ question }) => ({
      answers: [
        {
          question: question.questions[0].question,
          selectedLabels: ["No, revise: inspect migration source before writing"],
          selectedOptions: [question.questions[0].options[1]]
        }
      ]
    })
  });
  assert(!firstRevision.isError, `first revision plan tool errored: ${firstRevision.content}`);
  assert(
    firstRevision.content.includes("Plan not approved."),
    "first revision feedback was not visible"
  );
  assert(
    firstRevision.content.includes("Stay in plan mode."),
    "first revision guidance was not visible"
  );
  const revisionPlanId = parsePlanId(firstRevision.content);

  const secondRevision = await executeRegisteredTool({
    cwd: workDir,
    stateRoot: path.join(configDir, "state"),
    sessionId,
    toolUse: {
      type: "tool-use",
      id: "revise-goal-plan-second",
      name: "ExitPlanMode",
      input: { plan: secondRevisionPlanText }
    },
    userQuestionResolver: ({ question }) => ({
      answers: [
        {
          question: question.questions[0].question,
          selectedLabels: ["No, revise: include re-read verification after patch"],
          selectedOptions: [question.questions[0].options[1]]
        }
      ]
    })
  });
  assert(!secondRevision.isError, `second revision plan tool errored: ${secondRevision.content}`);
  assert(
    secondRevision.content.includes("Plan not approved."),
    "second revision feedback was not visible"
  );
  assert(
    secondRevision.content.includes("Stay in plan mode."),
    "second revision guidance was not visible"
  );
  const secondRevisionPlanId = parsePlanId(secondRevision.content);

  const approved = await executeRegisteredTool({
    cwd: workDir,
    stateRoot: path.join(configDir, "state"),
    sessionId,
    toolUse: {
      type: "tool-use",
      id: "approve-goal-plan",
      name: "ExitPlanMode",
      input: { plan: approvedPlanText }
    },
    userQuestionResolver: ({ question }) => ({
      answers: [
        {
          question: question.questions[0].question,
          selectedLabels: ["Yes, proceed"],
          selectedOptions: [question.questions[0].options[0]]
        }
      ]
    })
  });
  assert(!approved.isError, `approved plan tool errored: ${approved.content}`);
  assert(approved.content.includes("Plan approved."), "approval feedback was not visible");
  assert(approved.content.includes(approvedPlanText), "approved plan text was not visible");
  const approvedPlanId = parsePlanId(approved.content);

  return {
    revisionFeedbackSeen: true,
    multiRoundPlanFeedbackSeen: true,
    approvalSeen: true,
    revisionPlanId,
    secondRevisionPlanId,
    approvedPlanId,
    toolCounts
  };
}

function assertPlanStoreRevisionPersisted(planId) {
  const plans = JSON.parse(readFileSync(path.join(configDir, "state", "plans.json"), "utf8")).plans;
  const plan = plans.find((candidate) => candidate.id === planId);
  assert(plan, "revision plan record was not persisted");
  assert(plan.sessionId === sessionId, "revision plan used the wrong session");
  assert(plan.status === "needs_revision", "revision plan should need revision");
  assert(plan.toolUseId === "revise-goal-plan-first", "revision plan missed tool id");
  assert(
    plan.response === "No, revise: inspect migration source before writing",
    "revision plan missed user feedback"
  );
  assert(plan.plan === firstRevisionPlanText, "revision plan text was not persisted");
  return true;
}

function assertPlanStoreSecondRevisionPersisted(planId) {
  const plans = JSON.parse(readFileSync(path.join(configDir, "state", "plans.json"), "utf8")).plans;
  const plan = plans.find((candidate) => candidate.id === planId);
  assert(plan, "second revision plan record was not persisted");
  assert(plan.sessionId === sessionId, "second revision plan used the wrong session");
  assert(plan.status === "needs_revision", "second revision plan should need revision");
  assert(plan.toolUseId === "revise-goal-plan-second", "second revision plan missed tool id");
  assert(
    plan.response === "No, revise: include re-read verification after patch",
    "second revision plan missed user feedback"
  );
  assert(plan.plan === secondRevisionPlanText, "second revision plan text was not persisted");
  return true;
}

function assertPlanStoreApprovalPersisted(planId) {
  const plans = JSON.parse(readFileSync(path.join(configDir, "state", "plans.json"), "utf8")).plans;
  const plan = plans.find((candidate) => candidate.id === planId);
  assert(plan, "approved plan record was not persisted");
  assert(plan.sessionId === sessionId, "approved plan used the wrong session");
  assert(plan.status === "approved", "approved plan should be approved");
  assert(plan.toolUseId === "approve-goal-plan", "approved plan missed tool id");
  assert(plan.response === "Yes, proceed", "approved plan missed approval response");
  assert(plan.plan === approvedPlanText, "approved plan text was not persisted");
  return true;
}

function assertPlanRevisionChainLinked(revisionPlanId, secondRevisionPlanId, approvedPlanId) {
  const plans = JSON.parse(readFileSync(path.join(configDir, "state", "plans.json"), "utf8")).plans;
  const revision = plans.find((candidate) => candidate.id === revisionPlanId);
  const secondRevision = plans.find((candidate) => candidate.id === secondRevisionPlanId);
  const approved = plans.find((candidate) => candidate.id === approvedPlanId);
  assert(revision, "revision chain missed original revision plan");
  assert(secondRevision, "revision chain missed second revision plan");
  assert(approved, "revision chain missed approved plan");
  assert(
    revision.revisedByPlanId === secondRevisionPlanId,
    "first revision plan was not linked to second revision"
  );
  assert(
    secondRevision.revisesPlanId === revisionPlanId,
    "second revision did not revise first revision"
  );
  assert(
    secondRevision.revisedByPlanId === approvedPlanId,
    "second revision was not linked to approved replacement"
  );
  assert(approved.revisesPlanId === secondRevisionPlanId, "approved plan did not revise prior plan");
  assert(approved.rootPlanId === revisionPlanId, "approved plan missed root plan id");
  return true;
}

function assertInheritedPlanExecutionFollowed() {
  const outputPath = path.join(workDir, inheritedPlanOutputPath);
  assert(existsSync(outputPath), "inherited plan execution did not create output file");
  const output = readFileSync(outputPath, "utf8");
  assert(output === inheritedPlanOutputContent, "inherited plan output content was wrong");
  assert(
    readFileSync(path.join(workDir, migrationTargetPath), "utf8") === migrationTargetAfter,
    "migration target did not remain migrated after inherited plan execution"
  );
  return true;
}

async function assertPlanRevisionChainViewListed(revisionPlanId, secondRevisionPlanId, approvedPlanId) {
  const chain = await runCli(["plan", "chain", approvedPlanId], "plan revision chain view");
  assert(chain.includes(`Plan chain: ${revisionPlanId}`), "plan chain view missed root id");
  assert(
    chain.includes(`1. needs_revision ${revisionPlanId}`),
    "plan chain view missed revision plan"
  );
  assert(
    chain.includes(`2. needs_revision ${secondRevisionPlanId}`),
    "plan chain view missed second revision plan"
  );
  assert(chain.includes(`3. approved ${approvedPlanId}`), "plan chain view missed approved plan");
  const show = await runCli(["plan", "show", revisionPlanId], "plan revision show view");
  assert(
    show.includes(`Revised by plan: ${secondRevisionPlanId}`),
    "plan show missed first revised-by link"
  );
  const secondShow = await runCli(
    ["plan", "show", secondRevisionPlanId],
    "second plan revision show view"
  );
  assert(
    secondShow.includes(`Revises plan: ${revisionPlanId}`),
    "second plan show missed revises link"
  );
  assert(
    secondShow.includes(`Revised by plan: ${approvedPlanId}`),
    "second plan show missed revised-by link"
  );
  return true;
}

async function assertCrossSessionPlanAdopted(sourcePlanId) {
  await runCli(
    [
      "--session-id",
      adoptedSessionId,
      "--model",
      "main",
      "-p",
      "Prepare adopted Goal/Plan eval session."
    ],
    "seed adopted session"
  );
  const adopted = await runCli(
    ["plan", "adopt", sourcePlanId, "--session-id", adoptedSessionId],
    "adopt approved plan"
  );
  assert(adopted.includes("Plan adopted:"), "plan adopt did not confirm");
  assert(adopted.includes(`Adopted from plan: ${sourcePlanId}`), "plan adopt missed source id");
  const status = await runCli(["plan", "--session-id", adoptedSessionId], "adopted plan status");
  assert(status.includes(`Adopted from plan: ${sourcePlanId}`), "adopted plan missed source plan");
  assert(
    status.includes(`Adopted from session: ${sessionId}`),
    "adopted plan missed source session"
  );
  assert(status.includes(approvedPlanText), "adopted plan missed approved plan text");
  return true;
}

async function runParallelPlanConflictFlow(executeRegisteredTool) {
  await runCli(
    [
      "--session-id",
      parallelAlphaSessionId,
      "--model",
      "main",
      "-p",
      "Prepare parallel alpha Goal/Plan eval session."
    ],
    "seed parallel alpha session"
  );
  await runCli(
    [
      "--session-id",
      parallelBetaSessionId,
      "--model",
      "main",
      "-p",
      "Prepare parallel beta Goal/Plan eval session."
    ],
    "seed parallel beta session"
  );

  const alpha = await approvePlanWithTool({
    executeRegisteredTool,
    sessionId: parallelAlphaSessionId,
    toolUseId: "approve-parallel-alpha-plan",
    plan: parallelAlphaPlanText
  });
  const beta = await approvePlanWithTool({
    executeRegisteredTool,
    sessionId: parallelBetaSessionId,
    toolUseId: "approve-parallel-beta-plan",
    plan: parallelBetaPlanText
  });

  assertPlanRecord({
    planId: alpha.planId,
    sessionId: parallelAlphaSessionId,
    plan: parallelAlphaPlanText,
    status: "approved"
  });
  assertPlanRecord({
    planId: beta.planId,
    sessionId: parallelBetaSessionId,
    plan: parallelBetaPlanText,
    status: "approved"
  });

  const alphaStatus = await runCli(
    ["plan", "--session-id", parallelAlphaSessionId],
    "parallel alpha plan status"
  );
  assert(alphaStatus.includes(parallelAlphaPlanText), "parallel alpha status missed alpha plan");
  assert(!alphaStatus.includes(parallelBetaPlanText), "parallel beta plan leaked into alpha status");
  const betaStatus = await runCli(
    ["plan", "--session-id", parallelBetaSessionId],
    "parallel beta plan status"
  );
  assert(betaStatus.includes(parallelBetaPlanText), "parallel beta status missed beta plan");
  assert(!betaStatus.includes(parallelAlphaPlanText), "parallel alpha plan leaked into beta status");

  const alphaContext = await runCli(
    [
      "--session-id",
      parallelAlphaSessionId,
      "--model",
      "main",
      "--output-format",
      "stream-json",
      "-p",
      "Verify parallel alpha plan context is isolated."
    ],
    "parallel alpha plan context"
  );
  assert(alphaContext.includes("Parallel alpha plan context is isolated"), "alpha context failed");
  const betaContext = await runCli(
    [
      "--session-id",
      parallelBetaSessionId,
      "--model",
      "main",
      "--output-format",
      "stream-json",
      "-p",
      "Verify parallel beta plan context is isolated."
    ],
    "parallel beta plan context"
  );
  assert(betaContext.includes("Parallel beta plan context is isolated"), "beta context failed");

  let conflictRejected = false;
  try {
    await runCli(
      ["plan", "adopt", beta.planId, "--session-id", parallelAlphaSessionId],
      "reject conflicting parallel adopt"
    );
  } catch (error) {
    conflictRejected = String(error).includes("already has an approved or submitted plan");
  }
  assert(conflictRejected, "parallel conflicting plan adopt was not rejected");

  await runCli(
    [
      "--session-id",
      parallelAdoptSessionId,
      "--model",
      "main",
      "-p",
      "Prepare parallel adopt Goal/Plan eval session."
    ],
    "seed parallel adopt session"
  );
  const adopted = await runCli(
    ["plan", "adopt", alpha.planId, "--session-id", parallelAdoptSessionId],
    "adopt parallel alpha plan"
  );
  assert(adopted.includes("Plan adopted:"), "parallel alpha adopt did not confirm");
  const adoptContext = await runCli(
    [
      "--session-id",
      parallelAdoptSessionId,
      "--model",
      "main",
      "--output-format",
      "stream-json",
      "-p",
      "Verify explicitly adopted parallel plan context."
    ],
    "parallel adopted plan context"
  );
  assert(
    adoptContext.includes("Explicitly adopted parallel plan context is present"),
    "parallel adopted context failed"
  );

  return {
    conflictRejected,
    adoptedExplicitly: true,
    alphaPlanId: alpha.planId,
    betaPlanId: beta.planId
  };
}

async function runMergedPlanFlow(alphaPlanId, betaPlanId) {
  await runCli(
    [
      "--session-id",
      mergedPlanSessionId,
      "--model",
      "main",
      "-p",
      "Prepare merged Goal/Plan eval session."
    ],
    "seed merged plan session"
  );
  const merged = await runCli(
    ["plan", "merge", alphaPlanId, betaPlanId, "--session-id", mergedPlanSessionId],
    "merge parallel approved plans"
  );
  assert(merged.includes("Plan merged:"), "plan merge did not confirm");
  assert(merged.includes(`Merged from plans: ${alphaPlanId}, ${betaPlanId}`), "plan merge missed sources");

  const status = await runCli(["plan", "--session-id", mergedPlanSessionId], "merged plan status");
  assert(status.includes(`Merged from plans: ${alphaPlanId}, ${betaPlanId}`), "merged plan missed source plans");
  assert(
    status.includes(`Merged from sessions: ${parallelAlphaSessionId}, ${parallelBetaSessionId}`),
    "merged plan missed source sessions"
  );
  assert(status.includes("Read alpha-source.txt"), "merged plan missed alpha read step");
  assert(status.includes("Patch alpha-target.txt"), "merged plan missed alpha patch step");
  assert(status.includes("Read beta-source.txt"), "merged plan missed beta read step");
  assert(status.includes("Patch beta-target.txt"), "merged plan missed beta patch step");

  const context = await runCli(
    [
      "--session-id",
      mergedPlanSessionId,
      "--model",
      "main",
      "--output-format",
      "stream-json",
      "-p",
      "Verify merged parallel plan context."
    ],
    "merged plan context"
  );
  assert(context.includes("Merged parallel plan context is present"), "merged plan context failed");

  return { mergedPlanCreated: true };
}

async function runConflictedMergeFlow(executeRegisteredTool) {
  await runCli(
    ["--session-id", conflictAlphaSessionId, "--model", "main", "-p", "Prepare conflict alpha plan session."],
    "seed conflict alpha session"
  );
  await runCli(
    ["--session-id", conflictBetaSessionId, "--model", "main", "-p", "Prepare conflict beta plan session."],
    "seed conflict beta session"
  );
  await runCli(
    ["--session-id", conflictMergeSessionId, "--model", "main", "-p", "Prepare conflict merge target session."],
    "seed conflict merge session"
  );

  const alpha = await approvePlanWithTool({
    executeRegisteredTool,
    sessionId: conflictAlphaSessionId,
    toolUseId: "approve-conflict-alpha-plan",
    plan: conflictAlphaPlanText
  });
  const beta = await approvePlanWithTool({
    executeRegisteredTool,
    sessionId: conflictBetaSessionId,
    toolUseId: "approve-conflict-beta-plan",
    plan: conflictBetaPlanText
  });

  const merged = await runCli(
    ["plan", "merge", alpha.planId, beta.planId, "--session-id", conflictMergeSessionId],
    "merge conflicting approved plans"
  );
  assert(merged.includes("Plan merged:"), "conflicted plan merge did not confirm");

  const status = await runCli(
    ["plan", "--session-id", conflictMergeSessionId],
    "conflicted merge status"
  );
  assert(status.includes("Status: needs_revision"), "conflicted merge should need revision");
  assert(status.includes("Merge conflicts: 1"), "conflicted merge missed conflict count");
  assert(status.includes("Conflict target: src/config.ts"), "conflicted merge missed target");
  assert(
    status.includes("Patch src/config.ts to use alpha endpoint"),
    "conflicted merge missed alpha step"
  );
  assert(
    status.includes("Patch src/config.ts to use beta endpoint"),
    "conflicted merge missed beta step"
  );

  const context = await runCli(
    [
      "--session-id",
      conflictMergeSessionId,
      "--model",
      "main",
      "--output-format",
      "stream-json",
      "-p",
      "Verify conflicted merged plan context."
    ],
    "conflicted merge context"
  );
  assert(
    context.includes("Conflicted merged plan context is present"),
    "conflicted merge context failed"
  );

  return { needsRevision: true };
}

async function approvePlanWithTool(input) {
  const result = await input.executeRegisteredTool({
    cwd: workDir,
    stateRoot: path.join(configDir, "state"),
    sessionId: input.sessionId,
    toolUse: {
      type: "tool-use",
      id: input.toolUseId,
      name: "ExitPlanMode",
      input: { plan: input.plan }
    },
    userQuestionResolver: ({ question }) => ({
      answers: [
        {
          question: question.questions[0].question,
          selectedLabels: ["Yes, proceed"],
          selectedOptions: [question.questions[0].options[0]]
        }
      ]
    })
  });
  assert(!result.isError, `parallel plan approval failed: ${result.content}`);
  assert(result.content.includes("Plan approved."), "parallel plan was not approved");
  return { planId: parsePlanId(result.content) };
}

function assertPlanRecord(input) {
  const plans = JSON.parse(readFileSync(path.join(configDir, "state", "plans.json"), "utf8")).plans;
  const plan = plans.find((candidate) => candidate.id === input.planId);
  assert(plan, `plan record not found: ${input.planId}`);
  assert(plan.sessionId === input.sessionId, "plan record used wrong session");
  assert(plan.plan === input.plan, "plan record persisted wrong text");
  assert(plan.status === input.status, "plan record persisted wrong status");
}

function parsePlanId(output) {
  const match = output.match(/Plan id:\s*([0-9a-f-]+)/i);
  assert(match, `could not parse plan id from output:\n${output}`);
  return match[1];
}

function renderConfig({ port }) {
  return [
    "defaultProvider: openai",
    "defaultModel: main",
    "providers:",
    "  openai:",
    "    type: openai",
    "    apiKeyEnv: MAGI_OPENAI_API_KEY",
    `    baseUrl: http://127.0.0.1:${port}/v1`,
    "models:",
    "  aliases:",
    "    main: openai:mock-main",
    "  fallbacks: {}",
    ""
  ].join("\n");
}

function messageText(text) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "mock-main",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: text }
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  };
}

function toolResponse(toolCalls) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "mock-main",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: { role: "assistant", content: "", tool_calls: toolCalls }
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  };
}

function toolCall(id, name, input) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(input)
    }
  };
}

function latestUserFromBody(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return textFromMessage(message);
    }
  }
  return "";
}

function systemPromptFromBody(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const message = messages.find((candidate) => candidate?.role === "system");
  return textFromMessage(message);
}

function transcriptFromBody(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map(textFromMessage).join("\n");
}

function textFromMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("\n");
  }
  return "";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
