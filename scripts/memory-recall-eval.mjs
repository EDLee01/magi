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
  dreamConflictGroupLifecycleSeen: false,
  assertions: [],
  filesVerified: []
};

try {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  runCli(["memory", "init"], "memory init");
  seedBusinessMemory();
  const evalOutput = runMemoryEval("memory recall eval");
  assertRestartRecall();
  await assertNaturalLanguageCorrectionLifecycle();
  assertDreamReviewLifecycle();
  assertMaintenanceLifecycle();
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
    recordAssertion("natural-language correction disputed stale memory");
    recordAssertion("natural-language correction recalled replacement only");
    recordAssertion("natural-language correction persisted agent audit");
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

  const postMaintenanceEval = runMemoryEval(
    "memory recall eval after maintenance",
    writeMaintenanceCaseFile()
  );
  assert(postMaintenanceEval.includes("threshold: PASS"), "memory eval failed after maintenance");
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
        cases: [
          ...(Array.isArray(suite.cases) ? suite.cases : []),
          {
            name: "protected workflow survives maintenance",
            query: "resilient memory verification workflow",
            expect: ["Resilient memory verification workflow"],
            minResults: 1
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
  recordFileVerified("memory-recall-maintenance-business.json");
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
    "  selectionModel: fast",
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
      if (body.model === "mock-fast") {
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

function draftId(output) {
  const match = /Created Memory Draft:\s+([a-z0-9_]+)/i.exec(output);
  assert(match, `could not parse memory draft id from output:\n${output}`);
  return match[1];
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
