#!/usr/bin/env node

import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { MemoryNodeStore } from "../dist/memory-node-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const defaultCaseFile = path.join(repoRoot, "tests", "fixtures", "memory-recall-business.json");

const options = parseArgs(process.argv.slice(2));
const root = options.keepRoot ?? mkdtempSync(path.join(os.tmpdir(), "magi-memory-eval-"));
const configDir = path.join(root, "config");
const workDir = path.join(root, "work");
const reportFile =
  options.reportFile ?? path.join(repoRoot, ".magi-reports", "memory-recall-eval.json");
const lifecycleEvidence = {
  conflictGroupViewSeen: false,
  conversationIdentityRecallSeen: false,
  dreamConflictGroupLifecycleSeen: false,
  longCycleFeedbackTrendSeen: false,
  longProjectFeedbackConvergenceSeen: false,
  longProjectLearningDraftRecallSeen: false,
  autonomousLearningCycleSeen: false,
  staleKnowledgeDemotionSeen: false,
  crossNodeRecommendationSeen: false,
  correctedMemoryConversationRecallSeen: false,
  projectCaseRecallSeen: false,
  multiProjectConflictRecallSeen: false,
  multilingualProjectRecallSeen: false,
  multiNodeSupersededCleanupSeen: false,
  maintenanceConfigBoundarySeen: false,
  assertions: [],
  filesVerified: []
};

try {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  runCli(["memory", "init"], "memory init");
  seedBusinessMemory();
  const evalOutput = runMemoryEval("memory recall eval");
  assertProjectCaseRecall();
  assertGraphEdgeReinforcement();
  await assertConversationIdentityRecall();
  assertUserFeedbackTrendLifecycle();
  assertLongCycleFeedbackTrendRecall();
  assertStaleKnowledgeDemotionLifecycle();
  assertRestartRecall();
  await assertNaturalLanguageCorrectionLifecycle();
  assertDreamReviewLifecycle();
  assertMaintenanceLifecycle();
  assertMultiProjectConflictRecall();
  assertMultilingualProjectRecall();
  assertLongProjectFeedbackConvergence();
  assertLongProjectLearningDraftRecall();
  await assertAutonomousLearningCycle();
  writeLifecycleEvidence();
  process.stdout.write(`${evalOutput.trim()}\nBusiness memory recall eval passed.\n`);
} finally {
  if (!options.keepRoot && !process.env.MAGI_KEEP_MEMORY_EVAL_TMP) {
    rmSync(root, { recursive: true, force: true });
  }
}

function seedBusinessMemory() {
  const userDraft = draftId(
    runCli(
      [
        "memory",
        "append",
        "user",
        [
          "## Edward creator identity",
          "Edward is the creator of Magi Next.",
          "Use this identity only as durable user context."
        ].join("\n")
      ],
      "append user identity"
    )
  );
  runCli(["memory", "draft", "apply", userDraft], "apply user identity");

  const projectDraft = draftId(
    runCli(
      [
        "memory",
        "append",
        "project",
        [
          "## Magi release verification",
          "Magi release verification requires business-level memory recall evals.",
          "",
          "## Run focused memory eval before broad verify",
          "Run focused memory eval before broad verify when changing Memory Graph behavior."
        ].join("\n")
      ],
      "append project verification workflow"
    )
  );
  runCli(["memory", "draft", "apply", projectDraft], "apply project verification workflow");

  runCli(
    [
      "memory",
      "link",
      "--from",
      "Magi release verification",
      "--to",
      "Run focused memory eval before broad verify",
      "--relation",
      "relates_to",
      "--weight",
      "0.9"
    ],
    "link verification workflow"
  );

  const rolloutProject = seedTypedGraphNode({
    type: "project",
    title: "Release rollout project",
    summary: "Release rollout project.",
    body: "Release rollout project uses staged deployment gates.",
    weight: 0.8
  });
  const rolloutWorkflow = seedTypedGraphNode({
    type: "workflow",
    title: "Deployment gate workflow",
    summary: "Deployment gate workflow.",
    body: "Run smoke verification before deployment expansion.",
    weight: 0.7
  });
  const rolloutHabit = seedTypedGraphNode({
    type: "work_habit",
    title: "Concise deployment reporting",
    summary: "Concise deployment reporting.",
    body: "Summarize expansion risks and verification outcome.",
    weight: 0.65
  });
  runCli(
    [
      "memory",
      "link",
      "--from",
      rolloutProject.id,
      "--to",
      rolloutWorkflow.id,
      "--relation",
      "depends_on",
      "--weight",
      "0.95"
    ],
    "link rollout project to workflow"
  );
  runCli(
    [
      "memory",
      "link",
      "--from",
      rolloutWorkflow.id,
      "--to",
      rolloutHabit.id,
      "--relation",
      "relates_to",
      "--weight",
      "0.95"
    ],
    "link rollout workflow to habit"
  );

  const staleDraft = draftId(
    runCli(
      [
        "memory",
        "append",
        "user",
        [
          "## Stale verification preference",
          "The user prefers verbose terminal dumps after verification."
        ].join("\n")
      ],
      "append stale verification preference"
    )
  );
  runCli(["memory", "draft", "apply", staleDraft], "apply stale verification preference");
  runCli(
    [
      "memory",
      "correct",
      "--target",
      "verbose terminal dumps",
      "--reason",
      "User corrected stale verification output preference.",
      "--replacement",
      "The user prefers concise verification summaries with only key outcomes.",
      "--replacement-title",
      "Correct verification output preference",
      "--replacement-summary",
      "Correct verification output preference.",
      "--type",
      "preference"
    ],
    "correct stale verification preference"
  );
}

function runMemoryEval(label, caseFile = options.caseFile) {
  const evalOutput = runCli(
    [
      "memory",
      "eval",
      "--case-file",
      caseFile,
      "--report",
      reportFile,
      ...(options.minScore === undefined ? [] : ["--min-score", String(options.minScore)])
    ],
    label
  );
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const assertionPrefix = label.includes("maintenance")
    ? "maintenance recall"
    : label.includes("Dream apply")
      ? "post-dream recall"
      : "initial recall";
  for (const result of report.results ?? []) {
    if (result?.passed === true && typeof result.name === "string") {
      recordAssertion(`${assertionPrefix}: ${result.name}`);
    }
  }
  assert(report.failed === 0, `memory recall eval had failed cases:\n${evalOutput}`);
  assert(report.thresholdPassed === true, `memory recall eval missed threshold:\n${evalOutput}`);
  assert(
    report.score >= (report.minScore ?? 1),
    `memory recall score below threshold:\n${evalOutput}`
  );
  return evalOutput;
}

function assertRestartRecall() {
  const search = runCli(["memory", "search", "Edward creator Magi Next"], "restart recall search");
  assert(search.includes("Edward creator identity"), "restart recall missed durable user identity");
  assert(
    search.includes("Edward is the creator of Magi Next"),
    "restart recall missed identity body"
  );
  recordAssertion("restart recall found durable user identity");
}

function assertGraphEdgeReinforcement() {
  const db = openDb();
  try {
    const row = db
      .prepare(
        `
        select count(*) as count
        from memory_edges
        where use_count > 0 and last_used_at is not null
      `
      )
      .get();
    assert(
      row && row.count > 0,
      "memory graph recall should reinforce traversed edges with usage metadata"
    );
  } finally {
    db.close();
  }
  recordAssertion("memory graph recall reinforced traversed edges");
}

async function assertConversationIdentityRecall() {
  const provider = await startMemoryIdentityProvider();
  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderMemoryIdentityConfig(provider.port),
      "utf8"
    );
    const output = await runCliAsync(
      [
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        "我是谁？请只根据你的长期记忆回答。"
      ],
      "conversation identity memory recall prompt"
    );
    assert(
      output.includes("You are Edward, creator of Magi Next."),
      "conversation identity prompt did not answer from durable memory"
    );
    assert(provider.calls.length >= 1, "conversation identity provider was not called");
    const transcript = provider.calls[0].transcript;
    assert(transcript.includes("[Hot Memory]"), "conversation prompt missed hot memory layer");
    assert(
      transcript.includes("Edward creator identity"),
      "conversation prompt missed identity memory title"
    );
    assert(
      transcript.includes("Edward is the creator of Magi Next"),
      "conversation prompt missed identity memory body"
    );
    assert(
      transcript.includes("我是谁") || transcript.includes("长期记忆"),
      "conversation prompt transcript missed user question"
    );
    lifecycleEvidence.conversationIdentityRecallSeen = true;
    recordAssertion("conversation prompt injected durable identity hot memory");
    recordAssertion("conversation prompt preserved identity question with memory context");
    recordAssertion("conversation prompt answered identity from durable memory");
  } finally {
    await provider.close();
    removeConfigFile();
  }
}

function assertUserFeedbackTrendLifecycle() {
  const workflow = nodeByTitle("Deployment gate workflow");
  const previousWeight = workflow.weight;
  const feedback = runCli(
    [
      "memory",
      "feedback",
      "--target",
      workflow.id,
      "--signal",
      "useful",
      "--reason",
      "Business eval confirmed this workflow was useful."
    ],
    "memory useful feedback"
  );
  assert(feedback.includes("Memory feedback applied"), "memory feedback did not run");
  assert(feedback.includes("signal: useful"), "memory feedback did not record useful signal");
  const updated = nodeById(workflow.id);
  assert(
    updated.weight > previousWeight,
    `memory useful feedback should increase node weight, got ${previousWeight} -> ${updated.weight}`
  );
  const trend = feedbackTrendByNodeId(workflow.id);
  assert(trend.useful >= 1, "memory feedback trend did not count useful feedback");
  assert(trend.lastSignal === "useful", "memory feedback trend did not persist latest signal");
  const trends = runCli(["memory", "feedback", "trends", "--limit", "5"], "memory feedback trends");
  assert(trends.includes("Memory feedback trends:"), "memory feedback trends did not render");
  assert(trends.includes("Deployment gate workflow"), "memory feedback trends missed workflow");
  assert(trends.includes("useful=1"), "memory feedback trends missed useful count");
  recordAssertion("user feedback increased useful memory weight");
  recordAssertion("user feedback persisted memory trend metadata");
  recordAssertion("user feedback trend view rendered useful memory");
}

function assertLongCycleFeedbackTrendRecall() {
  const workflow = nodeByTitle("Deployment gate workflow");
  const before = feedbackTrendByNodeId(workflow.id);
  const feedback = runCli(
    [
      "memory",
      "feedback",
      "--target",
      workflow.id,
      "--signal",
      "useful",
      "--reason",
      "Second independent CLI cycle confirmed this workflow should stay hot."
    ],
    "memory useful feedback second cycle"
  );
  assert(feedback.includes("Memory feedback applied"), "second memory feedback did not run");
  const after = feedbackTrendByNodeId(workflow.id);
  assert(
    after.useful >= (before.useful ?? 0) + 1,
    "long-cycle feedback trend did not persist additional useful feedback"
  );
  const restartedTrends = runCli(
    ["memory", "feedback", "trends", "--limit", "3", "--min-events", "2"],
    "memory feedback trends after CLI restart"
  );
  assert(
    restartedTrends.includes("Deployment gate workflow"),
    "restarted feedback trends missed hot workflow"
  );
  assert(
    restartedTrends.includes("useful=2"),
    "restarted feedback trends missed accumulated useful count"
  );

  const recalled = runCli(
    ["memory", "search", "smoke gate rollout"],
    "long-cycle feedback trend recall search"
  );
  assert(
    recalled.includes("Deployment gate workflow"),
    "long-cycle trend recall missed hot workflow"
  );
  assert(
    recalled.includes("Concise deployment reporting"),
    "long-cycle trend recall missed related workflow habit"
  );
  assert(recalled.includes("graph-distance:"), "long-cycle trend recall missed graph distance");

  lifecycleEvidence.longCycleFeedbackTrendSeen = true;
  lifecycleEvidence.crossNodeRecommendationSeen = true;
  recordAssertion("long-cycle feedback trend persisted across CLI process");
  recordAssertion("long-cycle feedback trend recalled hot workflow");
  recordAssertion("cross-node workflow recommendation surfaced related habit");
}

function assertLongProjectFeedbackConvergence() {
  const defaultWorkflow = seedTypedGraphNode({
    type: "workflow",
    title: "Default broad release workflow",
    summary: "Release workflow for long project cycles.",
    body: "Release workflow uses broad verification across all packages before project handoff.",
    weight: 0.72
  });
  const projectWorkflow = seedTypedGraphNode({
    type: "workflow",
    title: "Long project focused handoff workflow",
    summary: "Release workflow for long project cycles.",
    body: "Release workflow uses focused package checks, then concise project handoff notes.",
    weight: 0.38
  });

  const defaultFeedback = runCli(
    [
      "memory",
      "feedback",
      "--target",
      defaultWorkflow.id,
      "--signal",
      "irrelevant",
      "--reason",
      "A long project cycle rejected the broad default release workflow."
    ],
    "long project default workflow feedback"
  );
  assert(
    defaultFeedback.includes("signal: irrelevant"),
    "long project default workflow did not record irrelevant feedback"
  );

  const projectCycleReasons = [
    "Project cycle 1 used focused package checks and concise handoff notes.",
    "Project cycle 2 reused focused package checks for a similar release.",
    "Project cycle 3 confirmed focused checks before handoff should stay hot."
  ];
  for (const [index, reason] of projectCycleReasons.entries()) {
    const feedback = runCli(
      [
        "memory",
        "feedback",
        "--target",
        projectWorkflow.id,
        "--signal",
        "useful",
        "--reason",
        reason
      ],
      `long project focused workflow feedback ${index + 1}`
    );
    assert(
      feedback.includes("Memory feedback applied"),
      "long project focused workflow feedback did not run"
    );
    assert(feedback.includes("signal: useful"), "long project feedback did not record useful");
  }

  const projectTrend = feedbackTrendByNodeId(projectWorkflow.id);
  const defaultTrend = feedbackTrendByNodeId(defaultWorkflow.id);
  assert(projectTrend.useful >= 3, "long project workflow did not accumulate three useful signals");
  assert(
    defaultTrend.irrelevant >= 1,
    "long project default workflow did not accumulate irrelevant feedback"
  );
  assert(
    nodeById(projectWorkflow.id).weight > nodeById(defaultWorkflow.id).weight,
    "long project useful workflow did not outrank default workflow by weight"
  );

  const trends = runCli(
    ["memory", "feedback", "trends", "--limit", "5", "--min-events", "3"],
    "long project feedback trend list"
  );
  assert(
    trends.includes("Long project focused handoff workflow"),
    "long project feedback trends missed focused workflow"
  );
  assert(trends.includes("useful=3"), "long project feedback trends missed useful=3");

  const search = runCli(
    ["memory", "search", "release workflow project handoff notes"],
    "long project feedback convergence search"
  );
  const focusedIndex = search.indexOf("Long project focused handoff workflow");
  const defaultIndex = search.indexOf("Default broad release workflow");
  assert(focusedIndex >= 0, "long project search missed focused workflow");
  assert(defaultIndex >= 0, "long project search missed default workflow for comparison");
  assert(
    focusedIndex < defaultIndex,
    "long project feedback did not rank focused workflow before default workflow"
  );

  lifecycleEvidence.longProjectFeedbackConvergenceSeen = true;
  recordAssertion("long-project repeated useful feedback accumulated on focused workflow");
  recordAssertion("long-project irrelevant feedback cooled default workflow");
  recordAssertion("long-project feedback trend ranked focused workflow");
  recordAssertion("long-project search ranked focused workflow before default workflow");
}

function assertLongProjectLearningDraftRecall() {
  const draftOutput = runCli(
    [
      "learning",
      "propose",
      "--kind",
      "memory",
      "--target",
      "memory/workflows/incident-review.md",
      "--reason",
      "Three incident review cycles converged on the same concise rollback workflow.",
      "--evidence",
      "incident cycle alpha; incident cycle beta; incident cycle gamma",
      "--confidence",
      "0.92",
      [
        "## Incident review rollback workflow",
        "For long-running incident review projects, run focused rollback validation first,",
        "then write concise owner, impact, rollback risk, and verification notes.",
        "",
        "## Incident review handoff habit",
        "Keep incident review handoffs short and link each rollback decision to verification evidence."
      ].join("\n")
    ],
    "long project learning memory draft propose"
  );
  const draft = learningDraftId(draftOutput);
  const review = runCli(
    ["learning", "draft", "show", draft],
    "long project learning memory draft show"
  );
  assert(
    review.includes("Three incident review cycles converged"),
    "learning memory draft review missed reason"
  );
  assert(
    review.includes("incident cycle alpha; incident cycle beta; incident cycle gamma"),
    "learning memory draft review missed evidence"
  );

  const rejectedOutput = runCli(
    [
      "learning",
      "propose",
      "--kind",
      "memory",
      "--target",
      "memory/workflows/noisy-incident-review.md",
      "--reason",
      "A noisy draft should be rejected and must not enter memory recall.",
      "--evidence",
      "user rejected noisy draft",
      "--confidence",
      "0.4",
      [
        "## Noisy incident review workflow",
        "Long incident review projects should paste raw terminal logs into every handoff."
      ].join("\n")
    ],
    "long project noisy learning draft propose"
  );
  const rejectedDraft = learningDraftId(rejectedOutput);
  const rejected = runCli(
    ["learning", "draft", "reject", rejectedDraft],
    "long project noisy learning draft reject"
  );
  assert(rejected.includes("Rejected LearningDraft:"), "learning draft reject did not run");

  const applied = runCli(
    ["learning", "draft", "apply", draft],
    "long project learning memory draft apply"
  );
  assert(applied.includes("Applied LearningDraft:"), "learning memory draft apply did not run");

  const recall = runCli(
    ["memory", "search", "incident review rollback handoff verification"],
    "long project learning memory recall"
  );
  assert(
    recall.includes("Incident review rollback workflow"),
    "learning draft memory recall missed workflow"
  );
  assert(
    recall.includes("Incident review handoff habit"),
    "learning draft memory recall missed handoff habit"
  );
  assert(!recall.includes("raw terminal logs"), "rejected learning draft polluted memory recall");

  const workflow = nodeByTitle("Incident review rollback workflow");
  const beforeWeight = workflow.weight;
  const feedback = runCli(
    [
      "memory",
      "feedback",
      "--target",
      workflow.id,
      "--signal",
      "useful",
      "--reason",
      "Fourth incident review cycle confirmed this learned workflow should stay hot."
    ],
    "long project learned memory useful feedback"
  );
  assert(feedback.includes("Memory feedback applied"), "learned memory feedback did not run");
  assert(nodeById(workflow.id).weight > beforeWeight, "learned memory feedback did not raise weight");
  const trends = runCli(
    ["memory", "feedback", "trends", "--limit", "5"],
    "long project learned memory feedback trends"
  );
  assert(
    trends.includes("Incident review rollback workflow"),
    "learned memory feedback trend missed workflow"
  );
  assert(trends.includes("useful=1"), "learned memory feedback trend missed useful signal");

  const restartedRecall = runCli(
    ["memory", "search", "incident rollback owner impact verification notes"],
    "long project learned memory restart recall"
  );
  assert(
    restartedRecall.includes("Incident review rollback workflow"),
    "learned memory did not survive CLI restart"
  );
  assert(
    restartedRecall.includes("Incident review handoff habit"),
    "learned handoff habit did not survive CLI restart"
  );

  lifecycleEvidence.longProjectLearningDraftRecallSeen = true;
  recordAssertion("long-project learning draft reviewed with evidence");
  recordAssertion("long-project learning draft applied to memory graph");
  recordAssertion("rejected learning draft did not enter memory recall");
  recordAssertion("learned long-project workflow recalled across CLI process");
  recordAssertion("learned long-project workflow feedback raised weight");
}

async function assertAutonomousLearningCycle() {
  const provider = await startAutonomousLearningProvider();
  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderAutonomousLearningConfig(provider.port),
      "utf8"
    );
    const output = await runCliAsync(
      [
        "--model",
        "main",
        "-p",
        [
          "Run a long project cycle for the Phoenix billing migration.",
          "Track the recurring lesson across release alpha, release beta, release gamma, and release delta.",
          "Remember the reusable workflow for future project handoffs."
        ].join(" ")
      ],
      "autonomous long project learning prompt"
    );
    assert(
      output.includes("Phoenix migration cycle captured"),
      "autonomous learning prompt did not complete through provider"
    );

    const drafts = runCli(["learning", "list"], "autonomous learning draft list");
    assert(drafts.includes("LearningDrafts:"), "autonomous learning did not create a draft");
    assert(
      drafts.includes("workflows/README.md"),
      "autonomous learning draft did not target workflow memory"
    );
    const draft = newestLearningDraftId(drafts);
    const review = runCli(
      ["learning", "draft", "show", draft],
      "autonomous learning draft show"
    );
    assert(review.includes("tool results:"), "autonomous learning draft missed tool evidence");
    assert(
      review.includes("Phoenix billing migration"),
      "autonomous learning draft missed project cycle prompt"
    );
    assert(
      review.includes("Phoenix migration cycle captured"),
      "autonomous learning draft missed completed result excerpt"
    );

    const applied = runCli(
      ["learning", "draft", "apply", draft],
      "autonomous learning draft apply"
    );
    assert(applied.includes("Applied LearningDraft:"), "autonomous learning draft did not apply");

    const memoryFile = readFileSync(path.join(configDir, "memory", "workflows", "README.md"), "utf8");
    assert(
      memoryFile.includes(`LearningDraft ${draft}`),
      "autonomous learning draft source marker was not written to wiki memory"
    );
    assert(
      memoryFile.includes("Phoenix migration cycle captured"),
      "autonomous learning memory file missed completed result"
    );

    const recall = runCli(
      ["memory", "search", "Phoenix billing migration release alpha beta gamma handoff"],
      "autonomous learning recall"
    );
    assert(
      recall.includes("Learned Workflow:"),
      "autonomous learning recall missed learned workflow heading"
    );
    assert(
      recall.includes("Phoenix billing migration"),
      "autonomous learning recall missed project cycle context"
    );
    assert(
      recall.includes("source: workflows/README.md#Learned Workflow"),
      "autonomous learning recall was not served from wiki graph source"
    );

    const learned = newestWorkflowReadmeChunk();
    const existingHabit = seedTypedGraphNode({
      type: "work_habit",
      title: "Phoenix concise handoff habit",
      summary: "Phoenix concise handoff habit.",
      body: "Phoenix migration handoffs should keep owner, risk, verification, and next action together.",
      weight: 0.6
    });
    seedGraphEdge({
      fromNodeId: learned.nodeId,
      toNodeId: existingHabit.id,
      relation: "relates_to",
      weight: 0.96,
      reason: "Autonomous learning connected the new workflow to an existing handoff habit."
    });

    const neighborRecall = runCli(
      ["memory", "search", "Phoenix billing migration release cycle"],
      "autonomous learning graph neighbor recall"
    );
    assert(
      neighborRecall.includes("Phoenix concise handoff habit"),
      "autonomous learning recall missed connected handoff habit"
    );
    assert(
      neighborRecall.includes("graph-distance:"),
      "autonomous learning neighbor recall missed graph path metadata"
    );

    const learnedBefore = nodeById(learned.nodeId);
    const feedback = runCli(
      [
        "memory",
        "feedback",
        "--target",
        learned.nodeId,
        "--signal",
        "useful",
        "--reason",
        "Fifth Phoenix migration cycle reused the autonomous learning workflow."
      ],
      "autonomous learned workflow useful feedback"
    );
    assert(feedback.includes("Memory feedback applied"), "autonomous learning feedback did not run");
    assert(
      nodeById(learned.nodeId).weight > learnedBefore.weight,
      "autonomous learned workflow feedback did not raise weight"
    );
    const trends = runCli(
      ["memory", "feedback", "trends", "--limit", "5"],
      "autonomous learning feedback trends"
    );
    assert(
      trends.includes("Learned Workflow:"),
      "autonomous learning feedback trends missed learned workflow"
    );
    assert(trends.includes("useful=1"), "autonomous learning trends missed useful signal");

    assertAutonomousLearningSqliteLinked(learned, existingHabit.id);
    lifecycleEvidence.autonomousLearningCycleSeen = true;
    recordAssertion("autonomous post-task learning draft created from long project cycle");
    recordAssertion("autonomous learning draft review preserved project evidence");
    recordAssertion("autonomous learning draft applied into wiki memory");
    recordAssertion("autonomous learned workflow indexed into sqlite graph");
    recordAssertion("autonomous learned workflow linked to existing habit");
    recordAssertion("autonomous learned workflow recalled with graph neighbor");
    recordAssertion("autonomous learned workflow feedback raised weight and trend");
  } finally {
    await provider.close();
    removeConfigFile();
  }
}

function assertStaleKnowledgeDemotionLifecycle() {
  const stale = seedTypedGraphNode({
    type: "workflow",
    title: "Legacy invoice export workflow",
    summary: "Invoice export workflow.",
    body: "Invoice export workflow uses legacy spreadsheet manual reconciliation with invoice export checklist and manual review.",
    weight: 0.95
  });
  const current = seedTypedGraphNode({
    type: "workflow",
    title: "Current invoice export workflow",
    summary: "Invoice export workflow.",
    body: "Invoice export workflow uses automated ledger reconciliation.",
    weight: 0.45
  });
  makeNodesStale([stale.id], "2026-01-01T00:00:00.000Z");

  const configured = runCli(
    [
      "memory",
      "maintain",
      "config",
      "--older-than-days",
      "30",
      "--decay",
      "0.6",
      "--min-weight",
      "0.2",
      "--limit",
      "20"
    ],
    "memory stale knowledge maintenance config"
  );
  assert(configured.includes("decay: 0.600"), "stale knowledge config did not persist decay");
  assert(
    configured.includes("olderThanDays: 30"),
    "stale knowledge config did not persist bounded age window"
  );

  const maintained = runCli(["memory", "maintain", "--apply"], "memory stale knowledge decay");
  assert(
    maintained.includes("Legacy invoice export workflow"),
    "stale knowledge maintenance did not decay legacy workflow"
  );
  assert(
    nodeById(stale.id).weight < stale.weight,
    "stale knowledge maintenance did not lower legacy workflow weight"
  );

  for (const reason of [
    "Current invoice workflow matched this month's finance task.",
    "Second finance task confirmed the current invoice workflow."
  ]) {
    const feedback = runCli(
      [
        "memory",
        "feedback",
        "--target",
        current.id,
        "--signal",
        "useful",
        "--reason",
        reason
      ],
      "memory current invoice workflow useful feedback"
    );
    assert(feedback.includes("Memory feedback applied"), "current workflow feedback did not run");
  }

  const search = runCli(
    ["memory", "search", "invoice export workflow"],
    "memory stale knowledge demotion search"
  );
  const currentIndex = search.indexOf("Current invoice export workflow");
  const legacyIndex = search.indexOf("Legacy invoice export workflow");
  assert(currentIndex >= 0, "current invoice workflow was not recalled");
  assert(legacyIndex >= 0, "legacy invoice workflow was not still available for review");
  assert(
    currentIndex < legacyIndex,
    "current useful workflow should rank before stale keyword-heavy workflow"
  );

  const trends = runCli(
    ["memory", "feedback", "trends", "--limit", "5", "--min-events", "2"],
    "memory stale knowledge feedback trends"
  );
  assert(
    trends.includes("Current invoice export workflow"),
    "feedback trends missed current invoice workflow"
  );
  assert(trends.includes("useful=2"), "feedback trends missed repeated useful signal");

  lifecycleEvidence.staleKnowledgeDemotionSeen = true;
  recordAssertion("stale knowledge maintenance lowered old workflow weight");
  recordAssertion("repeated useful feedback made current workflow hot");
  recordAssertion("current workflow ranked before stale keyword-heavy workflow");
}

function assertProjectCaseRecall() {
  const output = runMemoryEval("memory recall eval for project cases", writeProjectCaseFile());
  assert(output.includes("project case recalls release owner"), "project case owner recall failed");
  assert(output.includes("project case recalls incident handoff"), "project case handoff recall failed");
  lifecycleEvidence.projectCaseRecallSeen = true;
  recordAssertion("project-level release owner recall passed");
  recordAssertion("project-level incident handoff recall passed");
}

function assertMultiProjectConflictRecall() {
  const graph = seedMultiProjectWikiMemory();
  const output = runMemoryEval(
    "memory recall eval for multi-project conflicts",
    writeMultiProjectConflictCaseFile()
  );
  assert(
    output.includes("multi-project Magi release rule wins in Magi context"),
    "multi-project Magi rule recall case did not run"
  );
  assert(
    output.includes("multi-project Kira support rule wins in Kira context"),
    "multi-project Kira rule recall case did not run"
  );

  const magiSearch = runCli(
    ["memory", "search", "Magi release approval npm publish concise verification summary"],
    "multi-project Magi policy search"
  );
  assert(magiSearch.includes("Magi release approval"), "Magi search missed Magi project rule");
  assert(magiSearch.includes("GitHub checks before npm publish"), "Magi search missed approval rule");
  assert(
    magiSearch.includes("Shared concise verification style"),
    "Magi search missed shared user preference"
  );
  assert(!magiSearch.includes("customer QA signoff"), "Magi search leaked Kira project rule");

  const kiraSearch = runCli(
    ["memory", "search", "Kira support approval deployment concise verification summary"],
    "multi-project Kira policy search"
  );
  assert(kiraSearch.includes("Kira support approval"), "Kira search missed Kira project rule");
  assert(kiraSearch.includes("customer QA signoff"), "Kira search missed customer QA rule");
  assert(
    kiraSearch.includes("Shared concise verification style"),
    "Kira search missed shared user preference"
  );
  assert(!kiraSearch.includes("GitHub checks before npm publish"), "Kira search leaked Magi rule");

  const conflicts = runCli(["memory", "conflicts", "--groups"], "multi-project conflict groups");
  assert(conflicts.includes("Magi release approval"), "conflict groups missed Magi project rule");
  assert(conflicts.includes("Kira support approval"), "conflict groups missed Kira project rule");
  assertSqliteWikiGraphLinked(graph);

  lifecycleEvidence.multiProjectConflictRecallSeen = true;
  recordAssertion("multi-project wiki sources indexed into sqlite");
  recordAssertion("multi-project conflict edges linked project rules");
  recordAssertion("multi-project Magi rule recalled without Kira rule");
  recordAssertion("multi-project Kira rule recalled without Magi rule");
  recordAssertion("shared user preference recalled across project rules");
}

function assertMultilingualProjectRecall() {
  const graph = seedMultilingualWikiMemory();
  const output = runMemoryEval(
    "memory recall eval for multilingual projects",
    writeMultilingualProjectCaseFile()
  );
  assert(
    output.includes("Spanish preference recalls concise verification"),
    "Spanish preference recall case did not run"
  );
  assert(
    output.includes("French project rule recalls recette validation"),
    "French project recall case did not run"
  );
  assert(
    output.includes("Japanese project rule recalls approval"),
    "Japanese project recall case did not run"
  );

  const spanishSearch = runCli(
    ["memory", "search", "preferencia verificacion concisa resultado clave"],
    "multilingual Spanish preference search"
  );
  assert(
    spanishSearch.includes("Preferencia de verificacion concisa"),
    "Spanish search missed Spanish user preference"
  );
  assert(
    spanishSearch.includes("resumen breve"),
    "Spanish search missed concise verification body"
  );

  const frenchSearch = runCli(
    ["memory", "search", "Projet Atlas recette validation client deploiement"],
    "multilingual French project search"
  );
  assert(
    frenchSearch.includes("Projet Atlas regle de recette"),
    "French search missed French project rule"
  );
  assert(frenchSearch.includes("validation client"), "French search missed validation client rule");
  assert(
    frenchSearch.includes("Preferencia de verificacion concisa"),
    "French project search missed linked shared Spanish preference"
  );
  assert(!frenchSearch.includes("承認者"), "French project search leaked Japanese approval rule");

  const japaneseSearch = runCli(
    ["memory", "search", "Sakura リリース 承認者 検証 要約"],
    "multilingual Japanese project search"
  );
  assert(
    japaneseSearch.includes("Sakura release approval rule"),
    "Japanese search missed Japanese project rule"
  );
  assert(japaneseSearch.includes("承認者"), "Japanese search missed approval body");
  assert(
    japaneseSearch.includes("Preferencia de verificacion concisa"),
    "Japanese project search missed linked shared Spanish preference"
  );
  assert(
    !japaneseSearch.includes("validation client"),
    "Japanese project search leaked French project rule"
  );

  assertMultilingualSqliteGraphLinked(graph);

  lifecycleEvidence.multilingualProjectRecallSeen = true;
  recordAssertion("multilingual Spanish preference recalled");
  recordAssertion("multilingual French project rule recalled with shared preference");
  recordAssertion("multilingual Japanese project rule recalled with shared preference");
  recordAssertion("multilingual project recall isolated unrelated project rule");
  recordAssertion("multilingual wiki sources indexed into sqlite");
  recordAssertion("multilingual project graph edges linked shared preference");
}

async function assertNaturalLanguageCorrectionLifecycle() {
  const stale = seedTypedGraphNode({
    type: "preference",
    title: "Natural language stale verification preference",
    summary: "The user prefers full terminal logs after verification.",
    body: "The user prefers full terminal logs after verification.",
    weight: 0.95
  });
  const provider = await startMemoryDecisionProvider({
    stalePhrase: "full terminal logs",
    replacement: "The user prefers concise verification summaries with key outcomes only."
  });
  try {
    writeFileSync(path.join(configDir, "config.yaml"), renderMemoryDecisionConfig(provider.port));
    const output = await runCliAsync(
      [
        "--model",
        "main",
        "-p",
        "这个记忆不对，我不是喜欢 full terminal logs，我应该是偏好 concise verification summaries"
      ],
      "natural language memory correction"
    );
    assert(output.includes("记忆已纠正"), "natural correction provider did not finish");
    const corrected = nodeById(stale.id);
    assert(corrected.status === "disputed", "natural correction did not dispute stale node");
    const replacement = nodeByTitle("Natural language corrected verification preference");
    assert(
      replacement.status === "active",
      "natural correction replacement node was not active"
    );
    const search = runCli(
      ["memory", "search", "full terminal logs verification"],
      "natural correction search"
    );
    assert(
      search.includes("concise verification summaries"),
      "natural correction replacement was not recalled"
    );
    assert(
      !search.includes("prefers full terminal logs"),
      "natural correction still recalled stale memory"
    );
    const audit = JSON.stringify(readSessionAuditEvents(20));
    assert(audit.includes("agent.memory.corrected"), "natural correction audit event missing");
    assert(
      provider.calls.some((call) => call.model === "mock-fast" && call.transcript.includes("action")),
      "memory decision model was not called for natural correction"
    );
    const recallOutput = await runCliAsync(
      [
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        "What should you remember about my verification output preference?"
      ],
      "corrected memory conversation recall"
    );
    assert(
      recallOutput.includes("concise verification summaries with key outcomes only"),
      "corrected memory conversation did not answer from replacement memory"
    );
    const recallCall = provider.calls.find(
      (call) =>
        call.model === "mock-main" &&
        call.transcript.includes("verification output preference") &&
        call.transcript.includes("concise verification summaries")
    );
    assert(recallCall, "corrected memory recall provider request was not found");
    assert(
      recallCall.transcript.includes("[Hot Memory]"),
      "corrected memory conversation missed hot memory layer"
    );
    assert(
      recallCall.transcript.includes("Natural language corrected verification preference"),
      "corrected memory conversation missed replacement memory title"
    );
    assert(
      !recallCall.transcript.includes("The user prefers full terminal logs after verification."),
      "corrected memory conversation still injected disputed stale memory"
    );
    lifecycleEvidence.correctedMemoryConversationRecallSeen = true;
    recordAssertion("natural-language correction disputed stale memory");
    recordAssertion("natural-language correction recalled replacement only");
    recordAssertion("natural-language correction persisted agent audit");
    recordAssertion("corrected memory conversation recalled replacement hot memory");
    recordAssertion("corrected memory conversation excluded disputed stale memory");
  } finally {
    await provider.close();
    removeConfigFile();
  }
}

function assertDreamReviewLifecycle() {
  const staleNodeId = nodeByTitle("Stale verification preference").id;
  assertConflictGroupView();
  const firstDream = runCli(["memory", "dream"], "memory dream cleanup preview");
  assert(firstDream.includes("archive_candidate"), "memory dream did not propose cleanup");
  const firstDreamId = dreamId(firstDream);
  const rejectedDream = runCli(
    ["memory", "dream", "reject", firstDreamId],
    "memory dream reject cleanup"
  );
  assert(rejectedDream.includes("Rejected Dream:"), "memory dream reject did not run");
  assert(
    rejectedDream.includes("Kept graph nodes:"),
    "memory dream reject did not report kept nodes"
  );
  assert(
    nodeById(staleNodeId).status !== "archived",
    "rejected Dream should not archive disputed node"
  );

  const secondDream = runCli(["memory", "dream"], "memory dream cleanup apply preview");
  assert(secondDream.includes("archive_candidate"), "memory dream did not re-propose cleanup");
  const secondDreamId = dreamId(secondDream);
  const appliedDream = runCli(
    ["memory", "dream", "apply", secondDreamId],
    "memory dream apply cleanup"
  );
  assert(appliedDream.includes("Applied Dream:"), "memory dream apply did not run");
  assert(nodeById(staleNodeId).status === "archived", "applied Dream should archive stale node");

  const postDreamEval = runMemoryEval("memory recall eval after Dream apply");
  assert(postDreamEval.includes("threshold: PASS"), "memory eval failed after Dream apply");
  assertConflictGroupDreamLifecycle();
}

function assertConflictGroupView() {
  const stale = nodeByTitle("Stale verification preference");
  const rawLogs = seedTypedGraphNode({
    type: "preference",
    title: "Raw terminal log preference",
    summary: "Stale raw terminal log preference.",
    body: "The user prefers raw terminal logs after verification.",
    weight: 0.35
  });
  seedConflictEdge({
    fromNodeId: stale.id,
    toNodeId: rawLogs.id,
    weight: 0.8,
    reason: "Both stale preferences describe verbose terminal output."
  });

  const groups = runCli(["memory", "conflicts", "--groups"], "memory conflict groups");
  assert(
    groups.includes("Memory graph conflict groups:"),
    "memory conflict group view did not list groups"
  );
  assert(groups.includes("nodes: 3"), "memory conflict group view did not group three nodes");
  assert(
    groups.includes("recommendation: prefer_node"),
    "memory conflict group view did not recommend the strongest node"
  );
  assert(
    groups.includes("Correct verification output preference"),
    "memory conflict group view missed corrected replacement node"
  );
  assert(
    groups.includes("Raw terminal log preference"),
    "memory conflict group view missed connected stale node"
  );
  lifecycleEvidence.conflictGroupViewSeen = true;
  recordAssertion("conflict group view listed stale and corrected preference nodes");
}

function seedConflictEdge(input) {
  const store = new MemoryNodeStore(path.join(configDir, "state", "sessions.sqlite"));
  try {
    store.addEdge({
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      relation: "conflicts_with",
      weight: input.weight,
      metadata: {
        reason: input.reason,
        evalSeed: "memory-recall-eval"
      }
    });
  } finally {
    store.close();
  }
}

function assertConflictGroupDreamLifecycle() {
  const created = seedConflictGroupNodes();
  const firstDream = runCli(["memory", "dream"], "memory dream conflict group preview");
  assert(firstDream.includes("conflict"), "memory dream did not include conflict group candidate");
  const firstDreamId = dreamId(firstDream);
  const firstManifest = dreamManifest(firstDreamId);
  assert(
    firstManifest.operations.some(
      (op) =>
        op.type === "conflict" &&
        op.graphConflictGroup?.preferredNodeId === created.current.id &&
        op.graphNodeIds?.includes(created.staleVerbose.id) &&
        op.graphNodeIds?.includes(created.staleRawLogs.id)
    ),
    "memory dream manifest missed graph conflict group metadata"
  );

  const rejected = runCli(
    ["memory", "dream", "reject", firstDreamId],
    "memory dream reject conflict group"
  );
  assert(rejected.includes("Rejected Dream:"), "Dream reject did not run");
  assert(
    nodeById(created.staleVerbose.id).status === "active" &&
      nodeById(created.staleRawLogs.id).status === "active",
    "Dream reject should keep non-preferred conflict nodes active"
  );

  const secondDream = runCli(["memory", "dream"], "memory dream conflict group apply preview");
  assert(secondDream.includes("conflict"), "memory dream did not re-propose conflict group");
  const secondDreamId = dreamId(secondDream);
  const applied = runCli(
    ["memory", "dream", "apply", secondDreamId],
    "memory dream apply conflict group"
  );
  assert(applied.includes("Applied Dream:"), "Dream apply did not run");
  assert(nodeById(created.current.id).status === "active", "Dream apply archived preferred node");
  assert(
    nodeById(created.staleVerbose.id).status === "archived" &&
      nodeById(created.staleRawLogs.id).status === "archived",
    "Dream apply did not archive conflict group stale nodes"
  );
  lifecycleEvidence.dreamConflictGroupLifecycleSeen = true;
  recordAssertion("Dream conflict group reject kept stale nodes active");
  recordAssertion("Dream conflict group apply archived stale nodes and kept preferred node");
}

function assertMultiNodeSupersededCleanupLifecycle() {
  const replacement = seedTypedGraphNode({
    type: "project",
    title: "Current project release policy",
    summary: "Current project release policy.",
    body: "Project release policy uses focused validation and concise release notes.",
    weight: 0.96,
    metadata: { correctionFor: "project-release-policy-old" }
  });
  const staleManual = seedTypedGraphNode({
    type: "project",
    title: "Deprecated project release manual",
    summary: "Deprecated project release manual.",
    body: "Project release policy requires broad validation and raw release logs.",
    weight: 0.28
  });
  const staleChecklist = seedTypedGraphNode({
    type: "project",
    title: "Deprecated project release checklist",
    summary: "Deprecated project release checklist.",
    body: "Project release checklist requires full terminal dumps during release.",
    weight: 0.27
  });
  seedSupersedesEdge({
    fromNodeId: replacement.id,
    toNodeId: staleManual.id,
    reason: "Current release policy supersedes the old manual."
  });
  seedSupersedesEdge({
    fromNodeId: replacement.id,
    toNodeId: staleChecklist.id,
    reason: "Current release policy supersedes the old checklist."
  });
  disputeNodes([staleManual.id, staleChecklist.id]);

  const candidates = cleanupCandidates();
  assert(
    candidates.filter((candidate) => candidate.node.status === "disputed").length >= 2,
    "cleanup candidates missed multiple disputed superseded nodes"
  );
  assert(
    candidates.some((candidate) => candidate.node.id === staleManual.id) &&
      candidates.some((candidate) => candidate.node.id === staleChecklist.id),
    "cleanup candidates missed seeded superseded project nodes"
  );

  const dreamPreview = runCli(["memory", "dream"], "memory dream multi-node cleanup preview");
  assert(
    dreamPreview.includes("archive_candidate"),
    "Dream preview missed multi-node cleanup candidates"
  );
  const dreamIdValue = dreamId(dreamPreview);
  const manifest = dreamManifest(dreamIdValue);
  const cleanupNodeIds = new Set(
    manifest.operations.flatMap((op) => (Array.isArray(op.graphNodeIds) ? op.graphNodeIds : []))
  );
  assert(cleanupNodeIds.has(staleManual.id), "Dream manifest missed superseded manual node");
  assert(cleanupNodeIds.has(staleChecklist.id), "Dream manifest missed superseded checklist node");
  const applied = runCli(
    ["memory", "dream", "apply", dreamIdValue],
    "memory dream apply multi-node cleanup"
  );
  assert(applied.includes("Applied Dream:"), "Dream apply for multi-node cleanup did not run");
  assert(nodeById(replacement.id).status === "active", "Dream archived replacement node");
  assert(nodeById(staleManual.id).status === "archived", "Dream did not archive stale manual");
  assert(
    nodeById(staleChecklist.id).status === "archived",
    "Dream did not archive stale checklist"
  );

  const search = runCli(
    ["memory", "search", "project release policy raw release logs"],
    "post-cleanup project policy search"
  );
  assert(search.includes("focused validation"), "post-cleanup search missed current policy");
  assert(!search.includes("raw release logs"), "post-cleanup search recalled archived stale policy");

  lifecycleEvidence.multiNodeSupersededCleanupSeen = true;
  recordAssertion("multi-node superseded cleanup candidates listed disputed nodes");
  recordAssertion("Dream multi-node cleanup archived superseded project nodes");
  recordAssertion("post-cleanup project recall excluded archived superseded nodes");
}

function seedConflictGroupNodes() {
  const current = seedTypedGraphNode({
    type: "preference",
    title: "Current grouped output preference",
    summary: "Current grouped output preference.",
    body: "User prefers concise grouped verification summaries.",
    weight: 0.95,
    metadata: { correctionFor: "grouped-output-old" }
  });
  const staleVerbose = seedTypedGraphNode({
    type: "preference",
    title: "Verbose grouped output preference",
    summary: "Verbose grouped output preference.",
    body: "User prefers verbose grouped terminal dumps.",
    weight: 0.35
  });
  const staleRawLogs = seedTypedGraphNode({
    type: "preference",
    title: "Raw grouped log preference",
    summary: "Raw grouped log preference.",
    body: "User prefers raw grouped terminal logs after verification.",
    weight: 0.3
  });
  seedConflictEdge({
    fromNodeId: current.id,
    toNodeId: staleVerbose.id,
    weight: 1,
    reason: "Current grouped preference supersedes verbose grouped output."
  });
  seedConflictEdge({
    fromNodeId: staleVerbose.id,
    toNodeId: staleRawLogs.id,
    weight: 0.8,
    reason: "Grouped stale nodes describe verbose terminal output."
  });
  return { current, staleVerbose, staleRawLogs };
}

function assertMaintenanceLifecycle() {
  const target = nodeByTitle("Magi release verification");
  seedTypedGraphNode({
    type: "workflow",
    title: "Resilient memory verification workflow",
    summary: "Run focused memory eval before broad verify for Memory Graph changes.",
    body: "For Memory Graph changes, first run focused memory recall evals, then run broad verification."
  });
  seedTypedGraphNode({
    type: "project",
    title: "Ordinary memory project fact",
    summary: "The package currently publishes as @edwardlee5423/magi.",
    body: "The Magi package currently publishes as @edwardlee5423/magi."
  });
  const workflow = nodeByTitle("Resilient memory verification workflow");
  const projectFact = nodeByTitle("Ordinary memory project fact");
  makeNodesStale([workflow.id, projectFact.id], "2026-01-01T00:00:00.000Z");

  const configured = runCli(
    [
      "memory",
      "maintain",
      "config",
      "--older-than-days",
      "0",
      "--decay",
      "0.2",
      "--min-weight",
      "0.4",
      "--limit",
      "10"
    ],
    "memory maintenance config"
  );
  assert(configured.includes("Memory maintenance policy"), "maintenance config did not run");
  assert(configured.includes("decay: 0.200"), "maintenance config did not persist decay");

  const preview = runCli(["memory", "maintain"], "memory maintenance preview");
  assert(preview.includes("Memory maintenance preview"), "maintenance preview did not run");
  assert(preview.includes("changed:"), "maintenance preview did not report changed count");
  assert(
    nodeById(target.id).weight === target.weight,
    "maintenance preview should not change node weight"
  );
  assert(
    nodeById(workflow.id).weight === workflow.weight,
    "maintenance preview should not change workflow node weight"
  );

  const applied = runCli(["memory", "maintain", "--apply"], "memory maintenance apply");
  assert(applied.includes("Memory maintenance applied"), "maintenance apply did not run");
  assert(applied.includes("->"), "maintenance apply did not report weight change");
  assert(
    applied.includes("effectiveDecay=0.100"),
    "maintenance apply did not report protected workflow effective decay"
  );
  assert(
    applied.includes("effectiveDecay=0.200"),
    "maintenance apply did not report baseline effective decay"
  );
  const decayed = nodeById(target.id);
  assert(decayed.weight < target.weight, "maintenance apply should decay active node weight");
  const decayedWorkflow = nodeById(workflow.id);
  const decayedProjectFact = nodeById(projectFact.id);
  assert(
    decayedWorkflow.weight > decayedProjectFact.weight,
    "workflow memory should retain more weight than ordinary project facts"
  );
  assert(
    decayedWorkflow.weight === 0.81,
    `workflow memory expected weight 0.81 after protected decay, got ${decayedWorkflow.weight}`
  );
  assert(
    decayedProjectFact.weight === 0.72,
    `project fact expected weight 0.72 after baseline decay, got ${decayedProjectFact.weight}`
  );
  recordAssertion("maintenance preview did not mutate node weights");
  recordAssertion("maintenance apply decayed ordinary active node");
  recordAssertion("maintenance protected workflow decayed less than project fact");
  recordAssertion("maintenance persisted configurable decay policy");

  const bounded = runCli(
    [
      "memory",
      "maintain",
      "config",
      "--older-than-days",
      "5000",
      "--decay",
      "1",
      "--min-weight",
      "0",
      "--limit",
      "2000"
    ],
    "memory maintenance boundary config"
  );
  assert(bounded.includes("olderThanDays: 3650"), "maintenance config did not clamp olderThanDays");
  assert(bounded.includes("decay: 1.000"), "maintenance config did not clamp decay");
  assert(bounded.includes("minWeight: 0.000"), "maintenance config did not clamp minWeight");
  assert(bounded.includes("limit: 1000"), "maintenance config did not clamp limit");
  assertCliFails(
    [
      "memory",
      "maintain",
      "config",
      "--older-than-days",
      "-1"
    ],
    "memory maintenance negative boundary config",
    "must be a non-negative number"
  );
  assertCliFails(
    ["memory", "maintain", "config", "--decay", "1.5"],
    "memory maintenance invalid decay config",
    "must be a number between 0 and 1"
  );
  lifecycleEvidence.maintenanceConfigBoundarySeen = true;
  recordAssertion("maintenance config boundary values were clamped");
  recordAssertion("maintenance config invalid values were rejected");

  const postMaintenanceEval = runMemoryEval(
    "memory recall eval after maintenance",
    writeMaintenanceCaseFile()
  );
  assert(postMaintenanceEval.includes("threshold: PASS"), "memory eval failed after maintenance");
  assertMultiNodeSupersededCleanupLifecycle();
}

function writeProjectCaseFile() {
  const suite = JSON.parse(readFileSync(options.caseFile, "utf8"));
  const file = path.join(workDir, "memory-recall-project-business.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        ...suite,
        name: `${suite.name ?? "memory business recall"} with project cases`,
        maxResults: Math.max(suite.maxResults ?? 0, 10),
        cases: [
          ...(Array.isArray(suite.cases) ? suite.cases : []),
          {
            name: "project case recalls release owner",
            query: "Magi release verification owner",
            expect: ["Magi release verification", "business-level memory recall evals"],
            minResults: 1
          },
          {
            name: "project case recalls incident handoff",
            query: "release rollout incident handoff concise deployment",
            expect: ["Release rollout project", "Concise deployment reporting"],
            minResults: 2
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return file;
}

function writeMaintenanceCaseFile() {
  const suite = JSON.parse(readFileSync(options.caseFile, "utf8"));
  const file = path.join(workDir, "memory-recall-maintenance-business.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        ...suite,
        name: `${suite.name ?? "memory business recall"} with maintenance strategy`,
        maxResults: Math.max(suite.maxResults ?? 0, 10),
        cases: [
          ...(Array.isArray(suite.cases) ? suite.cases : []),
          ...maintenanceRecallCases()
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return file;
}

function writeMultiProjectConflictCaseFile() {
  const suite = JSON.parse(readFileSync(options.caseFile, "utf8"));
  const file = path.join(workDir, "memory-recall-multi-project-business.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        ...suite,
        name: `${suite.name ?? "memory business recall"} with maintenance and multi-project conflicts`,
        maxResults: Math.max(suite.maxResults ?? 0, 10),
        cases: [
          ...(Array.isArray(suite.cases) ? suite.cases : []),
          ...maintenanceRecallCases(),
          ...multiProjectConflictCases()
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return file;
}

function writeMultilingualProjectCaseFile() {
  const suite = JSON.parse(readFileSync(options.caseFile, "utf8"));
  const file = path.join(workDir, "memory-recall-multilingual-business.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        ...suite,
        name: `${suite.name ?? "memory business recall"} with multilingual project rules`,
        maxResults: Math.max(suite.maxResults ?? 0, 15),
        cases: [
          ...(Array.isArray(suite.cases) ? suite.cases : []),
          ...maintenanceRecallCases(),
          ...multiProjectConflictCases(),
          ...multilingualProjectCases()
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return file;
}

function maintenanceRecallCases() {
  return [
    {
      name: "protected workflow survives maintenance",
      query: "resilient memory verification workflow",
      expect: ["Resilient memory verification workflow"],
      minResults: 1
    },
    {
      name: "feedback trend recalls workflow neighborhood",
      query: "smoke gate rollout",
      expect: ["Deployment gate workflow", "Concise deployment reporting"],
      minResults: 2
    }
  ];
}

function multiProjectConflictCases() {
  return [
    {
      name: "multi-project Magi release rule wins in Magi context",
      query: "Magi release approval npm publish concise verification summary",
      expect: [
        "Magi release approval",
        "GitHub checks before npm publish",
        "Shared concise verification style"
      ],
      forbid: ["customer QA signoff"],
      minResults: 2
    },
    {
      name: "multi-project Kira support rule wins in Kira context",
      query: "Kira support approval deployment concise verification summary",
      expect: [
        "Kira support approval",
        "customer QA signoff",
        "Shared concise verification style"
      ],
      forbid: ["GitHub checks before npm publish"],
      minResults: 2
    }
  ];
}

function multilingualProjectCases() {
  return [
    {
      name: "Spanish preference recalls concise verification",
      query: "preferencia verificacion concisa resultado clave",
      expect: ["Preferencia de verificacion concisa", "resumen breve"],
      minResults: 1
    },
    {
      name: "French project rule recalls recette validation",
      query: "Projet Atlas recette validation client deploiement",
      expect: [
        "Projet Atlas regle de recette",
        "validation client",
        "Preferencia de verificacion concisa"
      ],
      forbid: ["承認者"],
      minResults: 2
    },
    {
      name: "Japanese project rule recalls approval",
      query: "Sakura リリース 承認者 検証 要約",
      expect: [
        "Sakura release approval rule",
        "承認者",
        "Preferencia de verificacion concisa"
      ],
      forbid: ["validation client"],
      minResults: 2
    }
  ];
}

function seedMultiProjectWikiMemory() {
  writeMemoryWikiFile(
    "preferences.md",
    [
      "# Preferences",
      "",
      "## Shared concise verification style",
      "Use concise verification summaries across projects unless a project-specific rule says otherwise."
    ].join("\n")
  );
  writeMemoryWikiFile(
    "projects/magi-release.md",
    [
      "## Magi release approval",
      "Magi release project requires approval through GitHub checks before npm publish.",
      "Use the shared concise verification style in release notes.",
      "",
      "## Magi release handoff",
      "Magi release handoff keeps owner, risk, and verification outcome together."
    ].join("\n")
  );
  writeMemoryWikiFile(
    "projects/kira-support.md",
    [
      "## Kira support approval",
      "Kira support project requires customer QA signoff before deployment.",
      "Use the shared concise verification style in customer-facing updates.",
      "",
      "## Kira support handoff",
      "Kira support handoff keeps customer impact, deployment window, and verification outcome together."
    ].join("\n")
  );
  runCli(
    ["memory", "search", "Magi release approval customer QA signoff"],
    "sync multi-project wiki memory"
  );

  const shared = wikiChunkByHeading("memory/preferences.md", "Shared concise verification style");
  const magi = wikiChunkByHeading("memory/projects/magi-release.md", "Magi release approval");
  const kira = wikiChunkByHeading("memory/projects/kira-support.md", "Kira support approval");
  seedGraphEdge({
    fromNodeId: shared.nodeId,
    toNodeId: magi.nodeId,
    relation: "relates_to",
    weight: 0.95,
    reason: "Shared user preference applies to Magi release project."
  });
  seedGraphEdge({
    fromNodeId: shared.nodeId,
    toNodeId: kira.nodeId,
    relation: "relates_to",
    weight: 0.95,
    reason: "Shared user preference applies to Kira support project."
  });
  seedConflictEdge({
    fromNodeId: magi.nodeId,
    toNodeId: kira.nodeId,
    weight: 0.9,
    reason: "Project-specific approval rules conflict and must resolve by project context."
  });
  return { shared, magi, kira };
}

function seedMultilingualWikiMemory() {
  writeMemoryWikiFile(
    "preferences-multilingual.md",
    [
      "## Preferencia de verificacion concisa",
      "El usuario prefiere un resumen breve con resultado clave y siguiente accion.",
      "Aplicar esta preferencia incluso cuando el proyecto use otro idioma."
    ].join("\n")
  );
  writeMemoryWikiFile(
    "projects/atlas-fr.md",
    [
      "## Projet Atlas regle de recette",
      "Le Projet Atlas exige une validation client avant le deploiement.",
      "Les notes de livraison doivent garder le resultat de verification et le risque ensemble."
    ].join("\n")
  );
  writeMemoryWikiFile(
    "projects/sakura-ja.md",
    [
      "## Sakura release approval rule",
      "Sakura リリース は 承認者 と 検証 要約 を 記録 してから deploy する。",
      "短い要約 には owner risk next action を含める。"
    ].join("\n")
  );
  runCli(
    ["memory", "search", "Projet Atlas Sakura preferencia verificacion"],
    "sync multilingual wiki memory"
  );

  const shared = wikiChunkByHeading(
    "memory/preferences-multilingual.md",
    "Preferencia de verificacion concisa"
  );
  const atlas = wikiChunkByHeading("memory/projects/atlas-fr.md", "Projet Atlas regle de recette");
  const sakura = wikiChunkByHeading("memory/projects/sakura-ja.md", "Sakura release approval rule");
  seedGraphEdge({
    fromNodeId: shared.nodeId,
    toNodeId: atlas.nodeId,
    relation: "relates_to",
    weight: 0.94,
    reason: "Shared concise verification preference applies to the French Atlas project."
  });
  seedGraphEdge({
    fromNodeId: shared.nodeId,
    toNodeId: sakura.nodeId,
    relation: "relates_to",
    weight: 0.94,
    reason: "Shared concise verification preference applies to the Japanese Sakura project."
  });
  seedConflictEdge({
    fromNodeId: atlas.nodeId,
    toNodeId: sakura.nodeId,
    weight: 0.75,
    reason: "Project-specific approval rules are isolated by project language context."
  });
  return { shared, atlas, sakura };
}

function writeMemoryWikiFile(filePath, content) {
  const absolutePath = path.join(configDir, "memory", filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${content.trimEnd()}\n`, "utf8");
}

function newestWorkflowReadmeChunk() {
  const store = new MemoryNodeStore(path.join(configDir, "state", "sessions.sqlite"));
  try {
    const source = store.getSourceByUri("memory/workflows/README.md");
    assert(source, "workflow README source was not indexed into sqlite");
    const chunks = store
      .listChunksForSource(source.id)
      .filter(
        (item) =>
          item.heading.startsWith("Learned Workflow:") &&
          item.body.includes("Phoenix billing migration")
      );
    assert(chunks.length > 0, "autonomous learned workflow chunk was not indexed");
    return chunks.at(-1);
  } finally {
    store.close();
  }
}

function wikiChunkByHeading(sourceUri, heading) {
  const store = new MemoryNodeStore(path.join(configDir, "state", "sessions.sqlite"));
  try {
    const source = store.getSourceByUri(sourceUri);
    assert(source, `memory source not found: ${sourceUri}`);
    const chunk = store.listChunksForSource(source.id).find((item) => item.heading === heading);
    assert(chunk, `memory chunk not found: ${sourceUri}#${heading}`);
    return { sourceId: source.id, sourceUri, heading, nodeId: chunk.nodeId, chunkId: chunk.id };
  } finally {
    store.close();
  }
}

function seedGraphEdge(input) {
  const store = new MemoryNodeStore(path.join(configDir, "state", "sessions.sqlite"));
  try {
    store.addEdge({
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      relation: input.relation,
      weight: input.weight,
      metadata: {
        reason: input.reason,
        evalSeed: "memory-recall-eval"
      }
    });
  } finally {
    store.close();
  }
}

function assertAutonomousLearningSqliteLinked(learned, habitNodeId) {
  const db = openDb();
  try {
    const source = db
      .prepare(
        `
        select count(*) as count
        from memory_sources
        where uri = 'memory/workflows/README.md' and status = 'active'
      `
      )
      .get();
    assert(source.count === 1, "autonomous learning wiki source was not active in sqlite");
    const chunk = db
      .prepare(
        `
        select count(*) as count
        from memory_chunks
        where node_id = ? and status = 'active'
      `
      )
      .get(learned.nodeId);
    assert(chunk.count === 1, "autonomous learned workflow chunk was not active in sqlite");
    const edge = db
      .prepare(
        `
        select count(*) as count
        from memory_edges
        where from_node_id = ? and to_node_id = ? and relation = 'relates_to'
      `
      )
      .get(learned.nodeId, habitNodeId);
    assert(edge.count === 1, "autonomous learned workflow graph edge was not persisted");
  } finally {
    db.close();
  }
}

function assertSqliteWikiGraphLinked(graph) {
  const db = openDb();
  try {
    const activeSources = db
      .prepare(
        `
        select count(*) as count
        from memory_sources
        where status = 'active'
          and uri in ('memory/preferences.md', 'memory/projects/magi-release.md', 'memory/projects/kira-support.md')
      `
      )
      .get();
    assert(activeSources.count === 3, "multi-project wiki sources were not active in sqlite");
    const activeChunks = db
      .prepare(
        `
        select count(*) as count
        from memory_chunks
        where status = 'active'
          and node_id in (?, ?, ?)
      `
      )
      .get(graph.shared.nodeId, graph.magi.nodeId, graph.kira.nodeId);
    assert(activeChunks.count === 3, "multi-project wiki chunks were not active in sqlite");
    const linkedEdges = db
      .prepare(
        `
        select count(*) as count
        from memory_edges
        where
          (from_node_id = ? and to_node_id = ? and relation = 'relates_to') or
          (from_node_id = ? and to_node_id = ? and relation = 'relates_to') or
          (from_node_id = ? and to_node_id = ? and relation = 'conflicts_with')
      `
      )
      .get(
        graph.shared.nodeId,
        graph.magi.nodeId,
        graph.shared.nodeId,
        graph.kira.nodeId,
        graph.magi.nodeId,
        graph.kira.nodeId
      );
    assert(linkedEdges.count === 3, "multi-project wiki graph edges were not persisted");
  } finally {
    db.close();
  }
}

function assertMultilingualSqliteGraphLinked(graph) {
  const db = openDb();
  try {
    const activeSources = db
      .prepare(
        `
        select count(*) as count
        from memory_sources
        where status = 'active'
          and uri in (
            'memory/preferences-multilingual.md',
            'memory/projects/atlas-fr.md',
            'memory/projects/sakura-ja.md'
          )
      `
      )
      .get();
    assert(activeSources.count === 3, "multilingual wiki sources were not active in sqlite");
    const activeChunks = db
      .prepare(
        `
        select count(*) as count
        from memory_chunks
        where status = 'active'
          and node_id in (?, ?, ?)
      `
      )
      .get(graph.shared.nodeId, graph.atlas.nodeId, graph.sakura.nodeId);
    assert(activeChunks.count === 3, "multilingual wiki chunks were not active in sqlite");
    const linkedEdges = db
      .prepare(
        `
        select count(*) as count
        from memory_edges
        where
          (from_node_id = ? and to_node_id = ? and relation = 'relates_to') or
          (from_node_id = ? and to_node_id = ? and relation = 'relates_to') or
          (from_node_id = ? and to_node_id = ? and relation = 'conflicts_with')
      `
      )
      .get(
        graph.shared.nodeId,
        graph.atlas.nodeId,
        graph.shared.nodeId,
        graph.sakura.nodeId,
        graph.atlas.nodeId,
        graph.sakura.nodeId
      );
    assert(linkedEdges.count === 3, "multilingual wiki graph edges were not persisted");
  } finally {
    db.close();
  }
}

function writeLifecycleEvidence() {
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  recordFileVerified(relativeToRoot(report.caseFile ?? options.caseFile));
  recordFileVerified(
    reportFile.startsWith(repoRoot)
      ? path.relative(repoRoot, reportFile)
      : relativeToRoot(reportFile)
  );
  recordFileVerified("state/sessions.sqlite");
  recordFileVerified("memory/dreams");
  recordFileVerified("memory-recall-project-business.json");
  recordFileVerified("memory-recall-multi-project-business.json");
  recordFileVerified("memory-recall-multilingual-business.json");
  recordFileVerified("memory-recall-maintenance-business.json");
  recordFileVerified("memory/workflows/README.md");
  recordFileVerified("state/learning-drafts");
  writeFileSync(
    reportFile,
    `${JSON.stringify(
      {
        ...report,
        details: {
          ...(report.details ?? {}),
          ...lifecycleEvidence,
          assertions: Array.from(new Set(lifecycleEvidence.assertions)),
          filesVerified: Array.from(new Set(lifecycleEvidence.filesVerified))
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function seedSupersedesEdge(input) {
  const store = new MemoryNodeStore(path.join(configDir, "state", "sessions.sqlite"));
  try {
    store.addEdge({
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      relation: "supersedes",
      weight: 1,
      metadata: {
        reason: input.reason,
        evalSeed: "memory-recall-eval"
      }
    });
  } finally {
    store.close();
  }
}

function disputeNodes(ids) {
  const db = openDb(false);
  try {
    const update = db.prepare(
      "update memory_nodes set status = 'disputed', updated_at = ? where id = ?"
    );
    const now = new Date().toISOString();
    for (const id of ids) {
      update.run(now, id);
    }
  } finally {
    db.close();
  }
}

function cleanupCandidates() {
  const store = new MemoryNodeStore(path.join(configDir, "state", "sessions.sqlite"));
  try {
    return store.listCleanupCandidates({ olderThanDays: 0, maxWeight: 1, limit: 20 });
  } finally {
    store.close();
  }
}

function recordAssertion(assertion) {
  lifecycleEvidence.assertions.push(assertion);
}

function recordFileVerified(file) {
  lifecycleEvidence.filesVerified.push(file);
}

function relativeToRoot(file) {
  const absolute = path.resolve(file);
  return path.relative(root, absolute) || path.basename(absolute);
}

function seedTypedGraphNode(input) {
  const store = new MemoryNodeStore(path.join(configDir, "state", "sessions.sqlite"));
  try {
    return store.upsertNode({
      ...input,
      source: "agent",
      weight: input.weight ?? 0.9,
      metadata: { evalSeed: "memory-recall-eval", ...(input.metadata ?? {}) }
    });
  } finally {
    store.close();
  }
}

function makeNodesStale(ids, timestamp) {
  const db = openDb(false);
  try {
    const update = db.prepare(
      "update memory_nodes set updated_at = ?, last_used_at = null where id = ?"
    );
    for (const id of ids) {
      update.run(timestamp, id);
    }
  } finally {
    db.close();
  }
}

function renderMemoryDecisionConfig(port) {
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
    "    fast: openai:mock-fast",
    "  fallbacks: {}",
    "memory:",
    "  enabled: true",
    "  autoWrite: explicit",
    "  maxResults: 5",
    "  writeDecisionModel: fast",
    "  scopes:",
    "    - user",
    "    - project",
    "    - session",
    ""
  ].join("\n");
}

function renderAutonomousLearningConfig(port) {
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
    "memory:",
    "  enabled: true",
    "  autoWrite: off",
    "  maxResults: 8",
    "  scopes:",
    "    - user",
    "    - project",
    "    - session",
    ""
  ].join("\n");
}

function renderMemoryIdentityConfig(port) {
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
    "memory:",
    "  enabled: true",
    "  autoWrite: off",
    "  maxResults: 8",
    "  scopes:",
    "    - user",
    "    - project",
    "    - session",
    ""
  ].join("\n");
}

function runCli(args, label) {
  if (!existsSync(cliPath)) {
    throw new Error("dist/cli.js does not exist. Run npm run build first.");
  }
  const result = spawnSync(process.execPath, [cliPath, "--no-color", ...args], {
    cwd: workDir,
    env: {
      ...process.env,
      MAGI_CONFIG_DIR: configDir,
      MAGI_OPENAI_API_KEY: "test-key",
      NO_COLOR: "1"
    },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit ${result.status ?? result.signal}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
  return result.stdout;
}

function assertCliFails(args, label, expectedError) {
  if (!existsSync(cliPath)) {
    throw new Error("dist/cli.js does not exist. Run npm run build first.");
  }
  const result = spawnSync(process.execPath, [cliPath, "--no-color", ...args], {
    cwd: workDir,
    env: {
      ...process.env,
      MAGI_CONFIG_DIR: configDir,
      MAGI_OPENAI_API_KEY: "test-key",
      NO_COLOR: "1"
    },
    encoding: "utf8"
  });
  assert(
    result.status !== 0,
    `${label} unexpectedly succeeded\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
  );
  assert(
    result.stderr.includes(expectedError) || result.stdout.includes(expectedError),
    `${label} did not include expected error "${expectedError}"\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
  );
}

function runCliAsync(args, label) {
  if (!existsSync(cliPath)) {
    throw new Error("dist/cli.js does not exist. Run npm run build first.");
  }
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
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
    }, 30_000);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${label} failed with exit ${code ?? signal}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
        )
      );
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function startMemoryDecisionProvider(input) {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw);
      const transcript = (body.messages ?? [])
        .map((message) =>
          Array.isArray(message.content)
            ? message.content.map((part) => part.text ?? "").join("\n")
            : String(message.content ?? "")
        )
        .join("\n");
      calls.push({ model: body.model, transcript });
      response.writeHead(200, { "content-type": "application/json" });
      if (body.model === "mock-fast" && transcript.includes(input.stalePhrase)) {
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "correct",
                    target: input.stalePhrase,
                    reason: "User corrected the remembered verification output preference.",
                    replacement: input.replacement,
                    replacementTitle: "Natural language corrected verification preference",
                    replacementSummary: "Natural language corrected verification preference.",
                    replacementType: "preference",
                    confidence: 0.93
                  })
                }
              }
            ],
            usage: { prompt_tokens: 12, completion_tokens: 9 }
          })
        );
        return;
      }
      if (body.model === "mock-fast") {
        response.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ action: "none" }) } }],
            usage: { prompt_tokens: 2, completion_tokens: 1 }
          })
        );
        return;
      }
      if (transcript.includes("这个记忆不对") || transcript.includes(input.stalePhrase)) {
        response.end(
          JSON.stringify({
            choices: [{ message: { content: "记忆已纠正" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
        );
        return;
      }
      if (transcript.includes("verification output preference")) {
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    "You prefer concise verification summaries with key outcomes only."
                }
              }
            ],
            usage: { prompt_tokens: 2, completion_tokens: 2 }
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "记忆已纠正" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object", "memory decision provider did not bind");
      resolve({
        port: address.port,
        calls,
        close: () => new Promise((closeResolve) => server.close(closeResolve))
      });
    });
  });
}

function startAutonomousLearningProvider() {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw);
      const transcript = (body.messages ?? [])
        .map((message) =>
          Array.isArray(message.content)
            ? message.content.map((part) => part.text ?? "").join("\n")
            : String(message.content ?? "")
        )
        .join("\n");
      calls.push({ model: body.model, transcript });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  "Phoenix migration cycle captured.",
                  "The reusable lesson is to run focused billing validation before broad release checks,",
                  "then keep owner, risk, verification, and next action in the handoff."
                ].join(" ")
              }
            }
          ],
          usage: { prompt_tokens: 25, completion_tokens: 16 }
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object", "autonomous learning provider did not bind");
      resolve({
        port: address.port,
        calls,
        close: () => new Promise((closeResolve) => server.close(closeResolve))
      });
    });
  });
}

function startMemoryIdentityProvider() {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw);
      const transcript = transcriptFromProviderBody(body);
      calls.push({ model: body.model, transcript });
      assert(
        transcript.includes("Edward is the creator of Magi Next"),
        "provider request did not include durable identity memory"
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "You are Edward, creator of Magi Next."
              }
            }
          ],
          usage: { prompt_tokens: 32, completion_tokens: 8 }
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object", "identity provider did not bind");
      resolve({
        port: address.port,
        calls,
        close: () => new Promise((closeResolve) => server.close(closeResolve))
      });
    });
  });
}

function transcriptFromProviderBody(body) {
  return (body.messages ?? [])
    .map((message) =>
      Array.isArray(message.content)
        ? message.content.map((part) => part.text ?? "").join("\n")
        : String(message.content ?? "")
    )
    .join("\n");
}

function draftId(output) {
  const match = /Created Memory Draft:\s+([a-z0-9_]+)/i.exec(output);
  assert(match, `could not parse memory draft id from output:\n${output}`);
  return match[1];
}

function learningDraftId(output) {
  const match = /Created LearningDraft:\s+([a-z0-9_]+)/i.exec(output);
  assert(match, `could not parse LearningDraft id from output:\n${output}`);
  return match[1];
}

function newestLearningDraftId(output) {
  const matches = [...output.matchAll(/\b(learn_[a-z0-9_]+)\b/gi)].map((match) => match[1]);
  assert(matches.length > 0, `could not parse LearningDraft id from output:\n${output}`);
  return matches.at(-1);
}

function removeConfigFile() {
  rmSync(path.join(configDir, "config.yaml"), { force: true });
}

function dreamId(output) {
  const match = /Experimental Dream created:\s+([a-z0-9_]+)/i.exec(output);
  assert(match, `could not parse Dream id from output:\n${output}`);
  return match[1];
}

function dreamManifest(id) {
  return JSON.parse(
    readFileSync(path.join(configDir, "memory", "dreams", id, "manifest.json"), "utf8")
  );
}

function nodeByTitle(title) {
  const db = openDb();
  try {
    const row = db
      .prepare(
        "select id, title, status, weight from memory_nodes where title = ? order by updated_at desc limit 1"
      )
      .get(title);
    assert(row, `memory node not found by title: ${title}`);
    return row;
  } finally {
    db.close();
  }
}

function nodeById(id) {
  const db = openDb();
  try {
    const row = db
      .prepare("select id, title, status, weight from memory_nodes where id = ?")
      .get(id);
    assert(row, `memory node not found by id: ${id}`);
    return row;
  } finally {
    db.close();
  }
}

function feedbackTrendByNodeId(id) {
  const db = openDb();
  try {
    const row = db
      .prepare("select metadata_json from memory_nodes where id = ?")
      .get(id);
    assert(row, `memory node metadata not found by id: ${id}`);
    const metadata = JSON.parse(row.metadata_json);
    return metadata.feedbackTrend ?? {};
  } finally {
    db.close();
  }
}

function readSessionAuditEvents(limit) {
  const db = openDb();
  try {
    return db
      .prepare("select action, target, metadata_json from audit_events order by id desc limit ?")
      .all(limit);
  } finally {
    db.close();
  }
}

function openDb(readonly = true) {
  return new Database(path.join(configDir, "state", "sessions.sqlite"), { readonly });
}

function parseArgs(args) {
  let caseFile = defaultCaseFile;
  let reportFile;
  let keepRoot;
  let minScore;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--case-file") {
      caseFile = path.resolve(args[++index] ?? "");
      continue;
    }
    if (arg === "--report") {
      reportFile = path.resolve(args[++index] ?? "");
      continue;
    }
    if (arg === "--keep-root") {
      keepRoot = path.resolve(args[++index] ?? "");
      continue;
    }
    if (arg === "--min-score") {
      const value = Number(args[++index]);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error("--min-score must be a number between 0 and 1");
      }
      minScore = value;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!caseFile) throw new Error("--case-file must not be empty");
  return { caseFile, reportFile, keepRoot, minScore };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
