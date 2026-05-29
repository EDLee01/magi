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
  process.env.MAGI_PATCH_EVAL_REPORT ??
  path.join(repoRoot, ".magi-reports", "patch-engine-eval.json");
const startedAt = new Date();

const root = process.env.MAGI_KEEP_PATCH_EVAL_TMP
  ? mkdtempSync(path.join(os.tmpdir(), "magi-patch-eval-keep-"))
  : mkdtempSync(path.join(os.tmpdir(), "magi-patch-eval-"));
const configDir = path.join(root, "config");
const workDir = path.join(root, "work");

let harnessReport;

try {
  assert(existsSync(cliPath), "dist/cli.js does not exist. Run npm run build first.");
  harnessReport = await import("../dist/harness-report.js");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(workDir, "src"), { recursive: true });
  writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: 9 }), "utf8");
  const approvalDiffPreviewSeen = await verifyFilePatchApprovalDiffPreview();

  const scenarios = [
    await runFilePatchRecoveryScenario({ approvalDiffPreviewSeen }),
    await runMultiFilePatchRecoveryScenario(),
    await runPatchConflictExplanationScenario(),
    await runPatchRollbackQualityScenario()
  ];
  const report = addPatchSummary(
    harnessReport.buildHarnessReport({
      name: "patch-engine-eval",
      startedAt,
      scenarios
    })
  );
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  assert(report.status === "passed", "Patch Engine eval did not pass all scenarios");
  console.log(
    `Patch Engine eval passed (${report.scenarios.length} scenarios, FilePatch rate=${report.details.patchUsageRate.toFixed(2)}, provider calls=${report.summary.providerCalls}).`
  );
  console.log(`Patch Engine report: ${reportPath}`);
} finally {
  if (!process.env.MAGI_KEEP_PATCH_EVAL_TMP) {
    rmSync(root, { recursive: true, force: true });
  }
}

function initialWidget() {
  return [
    "export function renderWidget(title: string, items: string[]): string {",
    "  const header = `Widget: ${title}`;",
    '  const body = items.map((item) => `- ${item}`).join("\\n");',
    '  return [header, body].join("\\n");',
    "}",
    "",
    'export const VERSION_LABEL = "widget-v1";',
    ""
  ].join("\n");
}

function initialPipeline() {
  return [
    "export interface Step {",
    "  name: string;",
    "  enabled: boolean;",
    "}",
    "",
    "export function summarizePipeline(steps: Step[]): string {",
    '  return steps.map((step) => step.name).join(", ");',
    "}",
    ""
  ].join("\n");
}

function initialPipelineDocs() {
  return [
    "# Pipeline",
    "",
    "- All steps are listed.",
    "- Disabled steps appear in output.",
    ""
  ].join("\n");
}

function initialConflictConfig() {
  return [
    "export const config = {",
    '  mode: "safe",',
    "  retries: 2,",
    '  output: "summary"',
    "};",
    ""
  ].join("\n");
}

function initialBillingRules() {
  return [
    "export interface Invoice {",
    "  subtotal: number;",
    "  discountCode?: string;",
    "}",
    "",
    "export function calculateTotal(invoice: Invoice): number {",
    "  const discounted = invoice.discountCode ? invoice.subtotal * 0.9 : invoice.subtotal;",
    "  return Math.round(discounted * 100) / 100;",
    "}",
    ""
  ].join("\n");
}

function initialBillingFixture() {
  return [
    "export const sampleInvoice = {",
    "  subtotal: 125,",
    '  discountCode: "SAVE10"',
    "};",
    ""
  ].join("\n");
}

async function runFilePatchRecoveryScenario({ approvalDiffPreviewSeen }) {
  writeFileSync(path.join(workDir, "src", "widget.ts"), initialWidget(), "utf8");
  const started = Date.now();
  const provider = await startProvider({ route: routePatchEval });
  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderConfig({ port: provider.port }),
      "utf8"
    );
    const result = await runCli([
      "--permission-mode",
      "acceptEdits",
      "--model",
      "main",
      "--output-format",
      "stream-json",
      "-p",
      [
        "Run the Patch Engine eval.",
        "Update src/widget.ts with a multi-line behavior change.",
        "Use FilePatch for the multi-line edit and recover if the first patch fails.",
        "Use FileEdit only for the exact VERSION_LABEL replacement.",
        "Do not use FileWrite for the existing file."
      ].join(" ")
    ]);
    assert(result.includes("session.completed"), "patch eval headless session did not complete");
    const file = readFileSync(path.join(workDir, "src", "widget.ts"), "utf8");
    assert(file.includes("title.trim()"), "FilePatch did not update title normalization");
    assert(
      file.includes(".filter((item) => item.trim().length > 0)"),
      "FilePatch did not add filtering"
    );
    assert(file.includes('body || "(empty)"'), "FilePatch did not add empty fallback");
    assert(file.includes('VERSION_LABEL = "widget-v2"'), "FileEdit did not update version label");
    assert(!file.includes("Widget: ${title}`"), "old widget header survived patch");

    const metrics = provider.metrics();
    assert(
      metrics.toolCounts.FilePatch === 2,
      "expected one failed and one successful FilePatch call"
    );
    assert(metrics.toolCounts.FileEdit === 1, "expected one exact FileEdit call");
    assert(!metrics.toolCounts.FileWrite, "FileWrite should not be used for existing file edits");
    assert(metrics.recoverySeen, "FilePatch recovery feedback was not returned to the model");
    assert(metrics.toolSearchRankedFilePatch, "ToolSearch did not rank FilePatch first");
    assert(approvalDiffPreviewSeen, "FilePatch approval diff preview was not generated");
    return passedScenario({
      name: "filepatch recovery workflow",
      started,
      provider,
      details: {
        toolCounts: metrics.toolCounts,
        patchUsageRate: patchUsageRate(metrics.toolCounts),
        recoverySeen: metrics.recoverySeen,
        toolSearchRankedFilePatch: metrics.toolSearchRankedFilePatch,
        approvalDiffPreviewSeen,
        assertions: [
          "failed FilePatch surfaced recovery guidance",
          "successful FilePatch updated multiline block",
          "FileEdit handled exact version replacement",
          "FileWrite avoided for existing file",
          "approval diff preview generated"
        ],
        filesVerified: ["src/widget.ts"]
      }
    });
  } finally {
    await provider.close();
  }
}

async function runMultiFilePatchRecoveryScenario() {
  writeFileSync(path.join(workDir, "src", "pipeline.ts"), initialPipeline(), "utf8");
  mkdirSync(path.join(workDir, "docs"), { recursive: true });
  writeFileSync(path.join(workDir, "docs", "pipeline.md"), initialPipelineDocs(), "utf8");
  const started = Date.now();
  const provider = await startProvider({ route: routePatchMultiFileEval });
  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderConfig({ port: provider.port }),
      "utf8"
    );
    const result = await runCli([
      "--permission-mode",
      "acceptEdits",
      "--model",
      "main",
      "--output-format",
      "stream-json",
      "-p",
      [
        "Run the multi-file Patch Engine eval.",
        "Update src/pipeline.ts and docs/pipeline.md with FilePatch.",
        "Recover if the first docs patch fails.",
        "Do not use FileWrite for existing files."
      ].join(" ")
    ]);
    assert(result.includes("session.completed"), "multi-file patch eval did not complete");
    const source = readFileSync(path.join(workDir, "src", "pipeline.ts"), "utf8");
    const docs = readFileSync(path.join(workDir, "docs", "pipeline.md"), "utf8");
    assert(source.includes("filter((step) => step.enabled)"), "source enabled filter missing");
    assert(source.includes("`${step.name}: enabled`"), "source summary label missing");
    assert(docs.includes("Only enabled steps appear in output."), "docs enabled behavior missing");
    assert(
      docs.includes("Summaries mark each listed step as enabled."),
      "docs summary note missing"
    );
    const metrics = provider.metrics();
    assert(
      metrics.toolCounts.FilePatch === 3,
      "expected one source patch, one failed docs patch, and one docs retry"
    );
    assert(!metrics.toolCounts.FileWrite, "FileWrite should not be used in multi-file patch eval");
    assert(metrics.recoverySeen, "multi-file FilePatch recovery feedback was not visible");
    return passedScenario({
      name: "multi-file patch recovery workflow",
      started,
      provider,
      details: {
        toolCounts: metrics.toolCounts,
        patchUsageRate: patchUsageRate(metrics.toolCounts),
        multiFileRecoverySeen: metrics.recoverySeen,
        fileWriteAvoided: !metrics.toolCounts.FileWrite,
        assertions: [
          "source file patched",
          "docs patch failure surfaced recovery guidance",
          "docs retry patch succeeded",
          "FileWrite avoided across files",
          "final response completed"
        ],
        filesVerified: ["src/pipeline.ts", "docs/pipeline.md"]
      }
    });
  } finally {
    await provider.close();
  }
}

async function runPatchConflictExplanationScenario() {
  const filePath = path.join(workDir, "src", "conflict-config.ts");
  const original = initialConflictConfig();
  writeFileSync(filePath, original, "utf8");
  const started = Date.now();
  const provider = await startProvider({ route: routePatchConflictEval });
  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderConfig({ port: provider.port }),
      "utf8"
    );
    const result = await runCli([
      "--permission-mode",
      "acceptEdits",
      "--model",
      "main",
      "--output-format",
      "stream-json",
      "-p",
      [
        "Run the Patch Engine conflict explanation eval.",
        "Attempt the requested FilePatch against src/conflict-config.ts.",
        "If the patch conflicts with the current file, explain the conflict and do not rewrite the file."
      ].join(" ")
    ]);
    assert(result.includes("session.completed"), "patch conflict eval did not complete");
    assert(result.includes("conflict explanation preserved file"), "final conflict report missing");
    const after = readFileSync(filePath, "utf8");
    assert(after === original, "failed FilePatch conflict should not change the file");
    const metrics = provider.metrics();
    assert(metrics.toolCounts.FilePatch === 1, "expected one failed FilePatch conflict attempt");
    assert(!metrics.toolCounts.FileWrite, "conflict explanation should not use FileWrite");
    assert(metrics.recoverySeen, "patch conflict recovery explanation was not visible");
    assert(metrics.patchConflictExplained, "patch conflict explanation markers were not visible");
    return passedScenario({
      name: "patch conflict explanation workflow",
      started,
      provider,
      details: {
        toolCounts: metrics.toolCounts,
        patchUsageRate: patchUsageRate(metrics.toolCounts),
        recoverySeen: metrics.recoverySeen,
        conflictExplanationSeen: metrics.patchConflictExplained,
        rollbackVerified: true,
        fileWriteAvoided: !metrics.toolCounts.FileWrite,
        assertions: [
          "failed conflicting patch explained mismatch",
          "current file snippet included",
          "failed patch left file unchanged",
          "FileWrite avoided after conflict"
        ],
        filesVerified: ["src/conflict-config.ts"]
      }
    });
  } finally {
    await provider.close();
  }
}

async function runPatchRollbackQualityScenario() {
  const sourcePath = path.join(workDir, "src", "billing.ts");
  const fixturePath = path.join(workDir, "src", "billing-fixture.ts");
  const originalSource = initialBillingRules();
  const originalFixture = initialBillingFixture();
  writeFileSync(sourcePath, originalSource, "utf8");
  writeFileSync(fixturePath, originalFixture, "utf8");
  const started = Date.now();
  const provider = await startProvider({ route: routePatchRollbackQualityEval });
  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderConfig({ port: provider.port }),
      "utf8"
    );
    const result = await runCli([
      "--permission-mode",
      "acceptEdits",
      "--model",
      "main",
      "--output-format",
      "stream-json",
      "-p",
      [
        "Run the Patch Engine rollback quality eval.",
        "Change src/billing.ts so discounts are applied after tax at an 8% tax rate.",
        "If an earlier patch changes the wrong behavior, recover with FilePatch.",
        "Do not edit src/billing-fixture.ts."
      ].join(" ")
    ]);
    assert(result.includes("session.completed"), "rollback quality patch eval did not complete");
    assert(result.includes("rollback quality verified"), "rollback quality final report missing");

    const finalSource = readFileSync(sourcePath, "utf8");
    const finalFixture = readFileSync(fixturePath, "utf8");
    assert(finalFixture === originalFixture, "unrelated billing fixture changed");
    assert(finalSource.includes("const taxed = invoice.subtotal * 1.08;"), "tax calculation missing");
    assert(
      finalSource.includes("const discounted = invoice.discountCode ? taxed * 0.9 : taxed;"),
      "discount-after-tax calculation missing"
    );
    assert(!finalSource.includes("invoice.subtotal * 0.85"), "bad interim discount survived");
    assert(!finalSource.includes("discounted * 1.08"), "discount-before-tax behavior survived");

    const metrics = provider.metrics();
    assert(metrics.toolCounts.FilePatch === 4, "rollback quality should use four FilePatch calls");
    assert(!metrics.toolCounts.FileWrite, "rollback quality should not use FileWrite");
    assert(metrics.rollbackQualitySeen, "rollback quality recovery transcript was not visible");
    const sourceChanged = finalSource !== originalSource;
    const fixtureChanged = finalFixture !== originalFixture;
    assert(sourceChanged, "target billing source did not change");
    assert(!fixtureChanged, "final diff should not include unrelated fixture");

    return passedScenario({
      name: "patch rollback final diff quality workflow",
      started,
      provider,
      details: {
        toolCounts: metrics.toolCounts,
        patchUsageRate: patchUsageRate(metrics.toolCounts),
        rollbackQualitySeen: metrics.rollbackQualitySeen,
        finalDiffQualityVerified: true,
        unrelatedFilePreserved: true,
        fileWriteAvoided: !metrics.toolCounts.FileWrite,
        assertions: [
          "bad successful patch was recovered",
          "final patch moved discount after tax",
      "interim wrong discount removed from final source",
      "unrelated fixture stayed unchanged",
      "final diff excluded unrelated file"
        ],
        filesVerified: ["src/billing.ts", "src/billing-fixture.ts"]
      }
    });
  } finally {
    await provider.close();
  }
}

async function verifyFilePatchApprovalDiffPreview() {
  const previewFile = path.join(workDir, "src", "approval-preview.ts");
  writeFileSync(previewFile, "const label = 'old';\nconst count = 1;\n", "utf8");
  const { executeRegisteredTool } = await import("../dist/tools/registry.js");
  let capturedDiff;
  const result = await executeRegisteredTool({
    cwd: workDir,
    toolUse: {
      type: "tool-use",
      id: "approval-preview",
      name: "FilePatch",
      input: {
        file_path: "src/approval-preview.ts",
        patch: ["@@", " const label = 'old';", "-const count = 1;", "+const count = 2;"].join("\n")
      }
    },
    permissionMode: "default",
    approvalResolver: async ({ permission }) => {
      capturedDiff = permission.diff;
      return false;
    }
  });

  const file = readFileSync(previewFile, "utf8");
  assert(result.isError === true, "FilePatch approval preview should stop when denied");
  assert(file.includes("const count = 1;"), "denied FilePatch approval should not edit the file");
  return Boolean(
    capturedDiff?.includes("-const count = 1;") && capturedDiff.includes("+const count = 2;")
  );
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

async function startProvider({ route }) {
  const calls = [];
  const plannedToolCounts = {};
  let turn = 0;
  let recoverySeen = false;
  let toolSearchRankedFilePatch = false;
  let patchConflictExplained = false;
  let rollbackQualitySeen = false;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const transcript = transcriptFromBody(body);
        const toolNames = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
        calls.push({ model: body.model, transcript, toolNames });
        const result = route({ transcript, toolNames, turn });
        turn += 1;
        const responseBody = result.body ?? result;
        const assistantContent = responseBody.choices?.[0]?.message?.content ?? "";
        for (const call of responseBody.choices?.[0]?.message?.tool_calls ?? []) {
          plannedToolCounts[call.function.name] = (plannedToolCounts[call.function.name] ?? 0) + 1;
        }
        if (
          transcript.includes("Recovery guidance:") &&
          transcript.includes("Current file snippet:")
        ) {
          recoverySeen = true;
        }
        if (
          transcript.includes("Patch tried to match:") &&
          transcript.includes('mode: "fast"') &&
          transcript.includes('mode: "safe"')
        ) {
          patchConflictExplained = true;
        }
        if (transcript.includes("1. FilePatch") && transcript.includes("intent: file-edit")) {
          toolSearchRankedFilePatch = true;
        }
        if (
          `${transcript}\n${assistantContent}`.includes("wrong discount was removed") &&
          `${transcript}\n${assistantContent}`.includes("billing-fixture.ts stayed unchanged")
        ) {
          rollbackQualitySeen = true;
        }
        response.writeHead(result.status ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(result.body ?? result));
      } catch (error) {
        console.error(
          `[patch-eval-provider] ${error instanceof Error ? error.message : String(error)}`
        );
        response.writeHead(500, { "content-type": "application/json" });
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
  assert(address && typeof address === "object", "patch eval provider did not bind");
  return {
    calls,
    port: address.port,
    metrics() {
      return {
        toolCounts: plannedToolCounts,
        recoverySeen,
        toolSearchRankedFilePatch,
        patchConflictExplained,
        rollbackQualitySeen
      };
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function routePatchEval({ transcript, toolNames, turn }) {
  if (turn === 0) {
    assert(toolNames.includes("ToolSearch"), "ToolSearch was not exposed");
    assert(toolNames.includes("FilePatch"), "FilePatch was not exposed");
    assert(transcript.includes("use FilePatch for multi-line edits"), "missing FilePatch guidance");
    assert(
      transcript.includes("use FileEdit only for one exact string replacement"),
      "missing FileEdit boundary guidance"
    );
    assert(transcript.includes("If FilePatch fails"), "missing FilePatch recovery guidance");
    return toolResponse([
      toolCall("patch-search", "ToolSearch", {
        query: "apply multi-line patch to existing file",
        max_results: 3
      }),
      toolCall("read-widget", "FileRead", { file_path: "src/widget.ts" })
    ]);
  }
  if (turn === 1) {
    assert(transcript.includes("1. FilePatch"), "ToolSearch did not rank FilePatch first");
    assert(transcript.includes("renderWidget"), "FileRead did not return widget source");
    return toolResponse([
      toolCall("bad-patch", "FilePatch", {
        file_path: "src/widget.ts",
        patch: [
          "@@",
          " export function renderWidget(title: string, items: string[]): string {",
          "-  const header = `Widget: ${title} stale`;",
          "+  const header = `Widget: ${title.trim()}`;"
        ].join("\n")
      })
    ]);
  }
  if (turn === 2) {
    assert(
      transcript.includes("Patch context did not match file"),
      "failed FilePatch was not visible"
    );
    assert(
      transcript.includes("Recovery guidance:"),
      "FilePatch recovery guidance was not visible"
    );
    return toolResponse([
      toolCall("good-patch", "FilePatch", {
        file_path: "src/widget.ts",
        patch: [
          "@@",
          " export function renderWidget(title: string, items: string[]): string {",
          "-  const header = `Widget: ${title}`;",
          '-  const body = items.map((item) => `- ${item}`).join("\\n");',
          '-  return [header, body].join("\\n");',
          "+  const header = `Widget: ${title.trim()}`;",
          "+  const body = items",
          "+    .filter((item) => item.trim().length > 0)",
          "+    .map((item) => `* ${item.trim()}`)",
          '+    .join("\\n");',
          '+  return [header, body || "(empty)"].join("\\n");',
          " }"
        ].join("\n")
      })
    ]);
  }
  if (turn === 3) {
    assert(
      transcript.includes("Patched src/widget.ts"),
      "successful FilePatch result was not visible"
    );
    return toolResponse([
      toolCall("version-edit", "FileEdit", {
        file_path: "src/widget.ts",
        old_string: 'export const VERSION_LABEL = "widget-v1";',
        new_string: 'export const VERSION_LABEL = "widget-v2";'
      })
    ]);
  }
  if (turn === 4) {
    assert(transcript.includes("Wrote src/widget.ts"), "FileEdit result was not visible");
    return messageText("Patch Engine eval completed with FilePatch recovery and exact FileEdit.");
  }
  return messageText("Patch Engine eval already completed.");
}

function routePatchMultiFileEval({ transcript, toolNames, turn }) {
  if (turn === 0) {
    assert(toolNames.includes("FilePatch"), "FilePatch was not exposed for multi-file eval");
    assert(transcript.includes("use FilePatch for multi-line edits"), "missing FilePatch guidance");
    return toolResponse([
      toolCall("read-pipeline-source", "FileRead", { file_path: "src/pipeline.ts" }),
      toolCall("read-pipeline-docs", "FileRead", { file_path: "docs/pipeline.md" })
    ]);
  }
  if (turn === 1) {
    assert(transcript.includes("summarizePipeline"), "pipeline source was not visible");
    assert(transcript.includes("Disabled steps appear"), "pipeline docs were not visible");
    return toolResponse([
      toolCall("patch-pipeline-source", "FilePatch", {
        file_path: "src/pipeline.ts",
        patch: [
          "@@",
          " export function summarizePipeline(steps: Step[]): string {",
          '-  return steps.map((step) => step.name).join(", ");',
          "+  return steps",
          "+    .filter((step) => step.enabled)",
          "+    .map((step) => `${step.name}: enabled`)",
          '+    .join(", ");',
          " }"
        ].join("\n")
      }),
      toolCall("bad-docs-patch", "FilePatch", {
        file_path: "docs/pipeline.md",
        patch: [
          "@@",
          " # Pipeline",
          " ",
          "- Disabled steps are always hidden.",
          "+- Only enabled steps appear in output."
        ].join("\n")
      })
    ]);
  }
  if (turn === 2) {
    assert(transcript.includes("Patched src/pipeline.ts"), "source patch result was not visible");
    assert(
      transcript.includes("FilePatch failed for docs/pipeline.md"),
      "docs patch failure was not visible"
    );
    assert(
      transcript.includes("Recovery guidance:"),
      "docs patch recovery guidance was not visible"
    );
    return toolResponse([
      toolCall("retry-docs-patch", "FilePatch", {
        file_path: "docs/pipeline.md",
        patch: [
          "@@",
          " # Pipeline",
          " ",
          " - All steps are listed.",
          "-- Disabled steps appear in output.",
          "+- Only enabled steps appear in output.",
          "+- Summaries mark each listed step as enabled."
        ].join("\n")
      })
    ]);
  }
  if (turn === 3) {
    assert(
      transcript.includes("Patched docs/pipeline.md"),
      "docs retry patch result was not visible"
    );
    return messageText("Multi-file Patch Engine eval completed with recovery.");
  }
  return messageText("Multi-file Patch Engine eval already completed.");
}

function routePatchConflictEval({ transcript, toolNames, turn }) {
  if (turn === 0) {
    assert(toolNames.includes("FilePatch"), "FilePatch was not exposed for conflict eval");
    assert(transcript.includes("use FilePatch for multi-line edits"), "missing FilePatch guidance");
    return toolResponse([
      toolCall("read-conflict-config", "FileRead", { file_path: "src/conflict-config.ts" })
    ]);
  }
  if (turn === 1) {
    assert(transcript.includes('mode: "safe"'), "conflict config source was not visible");
    return toolResponse([
      toolCall("conflicting-config-patch", "FilePatch", {
        file_path: "src/conflict-config.ts",
        patch: [
          "@@",
          " export const config = {",
          '-  mode: "fast",',
          '-  retries: 1,',
          '+  mode: "safe",',
          "+  retries: 3,",
          '   output: "summary"',
          " };"
        ].join("\n")
      })
    ]);
  }
  if (turn === 2) {
    assert(
      transcript.includes("Patch tried to match:"),
      "conflict explanation did not include attempted patch context"
    );
    assert(transcript.includes("Current file snippet:"), "conflict explanation missed current file");
    assert(transcript.includes('mode: "fast"'), "conflict explanation missed stale patch context");
    assert(transcript.includes('mode: "safe"'), "conflict explanation missed current file context");
    return messageText("Patch conflict explanation preserved file without rewrite.");
  }
  return messageText("Patch conflict eval already completed.");
}

function routePatchRollbackQualityEval({ transcript, toolNames, turn }) {
  if (turn === 0) {
    assert(toolNames.includes("FilePatch"), "FilePatch was not exposed for rollback quality eval");
    assert(transcript.includes("use FilePatch for multi-line edits"), "missing FilePatch guidance");
    return toolResponse([
      toolCall("read-billing-source", "FileRead", { file_path: "src/billing.ts" }),
      toolCall("read-billing-fixture", "FileRead", { file_path: "src/billing-fixture.ts" })
    ]);
  }
  if (turn === 1) {
    assert(transcript.includes("calculateTotal"), "billing source was not visible");
    assert(transcript.includes("sampleInvoice"), "billing fixture was not visible");
    return toolResponse([
      toolCall("bad-billing-patch", "FilePatch", {
        file_path: "src/billing.ts",
        patch: [
          "@@",
          " export function calculateTotal(invoice: Invoice): number {",
          "-  const discounted = invoice.discountCode ? invoice.subtotal * 0.9 : invoice.subtotal;",
          "+  const discounted = invoice.discountCode ? invoice.subtotal * 0.85 : invoice.subtotal;",
          "   return Math.round(discounted * 100) / 100;",
          " }"
        ].join("\n")
      }),
      toolCall("bad-fixture-patch", "FilePatch", {
        file_path: "src/billing-fixture.ts",
        patch: [
          "@@",
          " export const sampleInvoice = {",
          "-  subtotal: 125,",
          "+  subtotal: 130,",
          '   discountCode: "SAVE10"',
          " };"
        ].join("\n")
      })
    ]);
  }
  if (turn === 2) {
    assert(transcript.includes("Patched src/billing.ts"), "bad billing patch result was not visible");
    assert(
      transcript.includes("Patched src/billing-fixture.ts"),
      "bad fixture patch result was not visible"
    );
    return toolResponse([
      toolCall("recover-billing-patch", "FilePatch", {
        file_path: "src/billing.ts",
        patch: [
          "@@",
          " export function calculateTotal(invoice: Invoice): number {",
          "-  const discounted = invoice.discountCode ? invoice.subtotal * 0.85 : invoice.subtotal;",
          "+  const taxed = invoice.subtotal * 1.08;",
          "+  const discounted = invoice.discountCode ? taxed * 0.9 : taxed;",
          "   return Math.round(discounted * 100) / 100;",
          " }"
        ].join("\n")
      }),
      toolCall("restore-fixture-patch", "FilePatch", {
        file_path: "src/billing-fixture.ts",
        patch: [
          "@@",
          " export const sampleInvoice = {",
          "-  subtotal: 130,",
          "+  subtotal: 125,",
          '   discountCode: "SAVE10"',
          " };"
        ].join("\n")
      })
    ]);
  }
  if (turn === 3) {
    assert(transcript.includes("Patched src/billing.ts"), "recovery billing patch result missing");
    assert(transcript.includes("Patched src/billing-fixture.ts"), "fixture restore patch result missing");
    return messageText(
      "Patch rollback quality verified: wrong discount was removed and billing-fixture.ts stayed unchanged."
    );
  }
  return messageText("Patch rollback quality eval already completed.");
}

function passedScenario({ name, started, provider, details }) {
  return {
    name,
    status: "passed",
    durationMs: Date.now() - started,
    score: 1,
    failureKind: null,
    details: {
      provider: { callCount: provider.calls.length },
      ...details
    }
  };
}

function patchUsageRate(toolCounts) {
  const patchToolCalls =
    (toolCounts.FilePatch ?? 0) + (toolCounts.FileEdit ?? 0) + (toolCounts.FileWrite ?? 0);
  return patchToolCalls === 0 ? 0 : (toolCounts.FilePatch ?? 0) / patchToolCalls;
}

function addPatchSummary(report) {
  let totalPatchUsageNumerator = 0;
  let totalPatchUsageDenominator = 0;
  let filePatchCalls = 0;
  let fileEditCalls = 0;
  let fileWriteCalls = 0;
  let recoveryScenarioCount = 0;
  let multiFileRecoverySeen = false;
  let approvalDiffPreviewSeen = false;
  let toolSearchRankedFilePatch = false;
  let conflictExplanationSeen = false;
  let rollbackVerified = false;
  let finalDiffQualityVerified = false;
  let unrelatedFilePreserved = false;
  for (const scenario of report.scenarios) {
    const details = scenario.details ?? {};
    const counts = details.toolCounts ?? {};
    filePatchCalls += counts.FilePatch ?? 0;
    fileEditCalls += counts.FileEdit ?? 0;
    fileWriteCalls += counts.FileWrite ?? 0;
    const denominator = (counts.FilePatch ?? 0) + (counts.FileEdit ?? 0) + (counts.FileWrite ?? 0);
    totalPatchUsageNumerator += counts.FilePatch ?? 0;
    totalPatchUsageDenominator += denominator;
    if (details.recoverySeen || details.multiFileRecoverySeen || details.rollbackQualitySeen) {
      recoveryScenarioCount += 1;
    }
    multiFileRecoverySeen = multiFileRecoverySeen || details.multiFileRecoverySeen === true;
    approvalDiffPreviewSeen = approvalDiffPreviewSeen || details.approvalDiffPreviewSeen === true;
    conflictExplanationSeen =
      conflictExplanationSeen || details.conflictExplanationSeen === true;
    rollbackVerified = rollbackVerified || details.rollbackVerified === true;
    finalDiffQualityVerified =
      finalDiffQualityVerified || details.finalDiffQualityVerified === true;
    unrelatedFilePreserved = unrelatedFilePreserved || details.unrelatedFilePreserved === true;
    toolSearchRankedFilePatch =
      toolSearchRankedFilePatch || details.toolSearchRankedFilePatch === true;
  }
  return {
    ...report,
    details: {
      filePatchCalls,
      fileEditCalls,
      fileWriteCalls,
      patchUsageRate:
        totalPatchUsageDenominator === 0
          ? 0
          : totalPatchUsageNumerator / totalPatchUsageDenominator,
      recoveryScenarioCount,
      multiFileRecoverySeen,
      approvalDiffPreviewSeen,
      conflictExplanationSeen,
      rollbackVerified,
      finalDiffQualityVerified,
      unrelatedFilePreserved,
      toolSearchRankedFilePatch
    }
  };
}

function runCli(args, timeoutMs = 45_000) {
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
            `patch eval timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `patch eval failed with exit ${code ?? signal}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      resolve(stdout);
    });
  });
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

function transcriptFromBody(body) {
  return (body.messages ?? []).map(textFromMessage).join("\n");
}

function textFromMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part && typeof part.content === "string") return part.content;
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
