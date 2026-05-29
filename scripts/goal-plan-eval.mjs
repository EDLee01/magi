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
const activeGoalObjective = "inspect Goal/Plan lifecycle eval context";
const blockedGoalObjective = "wait for Goal/Plan blocked audit";
const completedGoalObjective = "complete Goal/Plan lifecycle eval";
const deniedWritePath = "blocked-plan-write.txt";
const planText = [
  "1. Inspect goal and plan state",
  "2. Verify mutation denial before implementation",
  "3. Persist the plan review before editing"
].join("\n");
const revisionPlanText = ["1. Edit immediately", "2. Verify later"].join("\n");
const approvedPlanText = [
  "1. Inspect the plan feedback",
  "2. Revise the implementation order",
  "3. Proceed only after approval"
].join("\n");

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
    blockedGoalPersisted: false
  };
  const provider = await startProvider({ routeRequest: createRouter(state) });
  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderConfig({ port: provider.port }),
      "utf8"
    );

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
    const planApprovalPersisted = assertPlanStoreApprovalPersisted(planRevision.approvedPlanId);
    assert(state.activeGoalContextSeen, "provider did not see active goal context");
    assert(state.completedGoalSuppressed, "provider still saw completed goal context");
    assert(state.blockedGoalSuppressed, "provider still saw blocked goal context");
    assert(state.writeDeniedInPlanMode, "provider did not observe plan-mode write denial");
    assert(state.planSubmittedToModel, "provider did not observe submitted plan feedback");

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
            activeGoalContextSeen: state.activeGoalContextSeen,
            completedGoalSuppressed: state.completedGoalSuppressed,
            blockedGoalSuppressed: state.blockedGoalSuppressed,
            writeDeniedInPlanMode: state.writeDeniedInPlanMode,
            planSubmittedToModel: state.planSubmittedToModel,
            planReviewPersisted,
            crossSessionPlanReviewListed,
            planRevisionFeedbackSeen: planRevision.revisionFeedbackSeen,
            planRevisionPersisted,
            planApprovalSeen: planRevision.approvalSeen,
            planApprovalPersisted,
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

    return messageText("OK");
  };
}

async function startProvider({ routeRequest }) {
  const calls = [];
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
        response.writeHead(result.status ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(result.body ?? result));
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
    close: () => new Promise((resolve) => server.close(resolve))
  };
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
  const revision = await executeRegisteredTool({
    cwd: workDir,
    stateRoot: path.join(configDir, "state"),
    sessionId,
    toolUse: {
      type: "tool-use",
      id: "revise-goal-plan",
      name: "ExitPlanMode",
      input: { plan: revisionPlanText }
    },
    userQuestionResolver: ({ question }) => ({
      answers: [
        {
          question: question.questions[0].question,
          selectedLabels: ["No, revise"],
          selectedOptions: [question.questions[0].options[1]]
        }
      ]
    })
  });
  assert(!revision.isError, `revision plan tool errored: ${revision.content}`);
  assert(revision.content.includes("Plan not approved."), "revision feedback was not visible");
  assert(revision.content.includes("Stay in plan mode."), "revision guidance was not visible");
  const revisionPlanId = parsePlanId(revision.content);

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
    approvalSeen: true,
    revisionPlanId,
    approvedPlanId
  };
}

function assertPlanStoreRevisionPersisted(planId) {
  const plans = JSON.parse(readFileSync(path.join(configDir, "state", "plans.json"), "utf8")).plans;
  const plan = plans.find((candidate) => candidate.id === planId);
  assert(plan, "revision plan record was not persisted");
  assert(plan.sessionId === sessionId, "revision plan used the wrong session");
  assert(plan.status === "needs_revision", "revision plan should need revision");
  assert(plan.toolUseId === "revise-goal-plan", "revision plan missed tool id");
  assert(plan.response === "No, revise", "revision plan missed user feedback");
  assert(plan.plan === revisionPlanText, "revision plan text was not persisted");
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
