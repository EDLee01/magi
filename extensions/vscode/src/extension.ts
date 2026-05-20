import * as vscode from "vscode";
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

/**
 * Magi Next VS Code extension entrypoint.
 *
 * Communicates with magi-next via the control HTTP API. Run `magi control start`
 * in a terminal first (or set MAGI_AUTOSTART_CONTROL=1).
 */

let outputChannel: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Magi Next");
  outputChannel.appendLine("Magi Next extension activated.");

  context.subscriptions.push(
    vscode.commands.registerCommand("magi-next.askWithSelection", () => askWithSelection()),
    vscode.commands.registerCommand("magi-next.askWithFile", (uri?: vscode.Uri) => askWithFile(uri)),
    vscode.commands.registerCommand("magi-next.openSession", () => openSession()),
    vscode.commands.registerCommand("magi-next.setControlEndpoint", () => configureEndpoint())
  );
}

export function deactivate() {
  outputChannel?.dispose();
}

async function askWithSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor.");
    return;
  }
  const selection = editor.document.getText(editor.selection);
  if (!selection.trim()) {
    vscode.window.showWarningMessage("Make a selection first.");
    return;
  }
  const userPrompt = await vscode.window.showInputBox({
    prompt: "Ask Magi about the selected code",
    placeHolder: "e.g. explain this, find bugs, refactor"
  });
  if (!userPrompt) return;

  const filePath = vscode.workspace.asRelativePath(editor.document.uri);
  const lang = editor.document.languageId;
  const startLine = editor.selection.start.line + 1;
  const endLine = editor.selection.end.line + 1;
  const prompt = [
    userPrompt,
    "",
    `File: ${filePath}:${startLine}-${endLine}`,
    `Language: ${lang}`,
    "",
    "```" + lang,
    selection,
    "```"
  ].join("\n");

  await sendToMagi(prompt);
}

async function askWithFile(uri?: vscode.Uri): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    vscode.window.showWarningMessage("No file selected.");
    return;
  }
  const userPrompt = await vscode.window.showInputBox({
    prompt: `Ask Magi about ${vscode.workspace.asRelativePath(target)}`,
    placeHolder: "e.g. explain this file, find issues, suggest improvements"
  });
  if (!userPrompt) return;

  const relPath = vscode.workspace.asRelativePath(target);
  const prompt = `${userPrompt}\n\nFile: @${relPath}`;
  await sendToMagi(prompt);
}

async function openSession(): Promise<void> {
  const config = vscode.workspace.getConfiguration("magiNext");
  const endpoint = config.get<string>("controlEndpoint", "http://127.0.0.1:8765");
  vscode.env.openExternal(vscode.Uri.parse(`${endpoint}/panel`));
}

async function configureEndpoint(): Promise<void> {
  const config = vscode.workspace.getConfiguration("magiNext");
  const current = config.get<string>("controlEndpoint", "http://127.0.0.1:8765");
  const endpoint = await vscode.window.showInputBox({
    prompt: "Magi Next control API endpoint",
    value: current
  });
  if (!endpoint) return;
  await config.update("controlEndpoint", endpoint, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Magi Next endpoint set to ${endpoint}`);
}

async function sendToMagi(prompt: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("magiNext");
  const endpoint = config.get<string>("controlEndpoint", "http://127.0.0.1:8765");
  const token = config.get<string>("controlToken", "");
  const modelAlias = config.get<string>("modelAlias", "auto");
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  outputChannel?.show(true);
  outputChannel?.appendLine(`\n→ Sending to Magi Next (${endpoint}, model=${modelAlias})`);
  outputChannel?.appendLine(`  cwd: ${cwd}`);

  // Step 1: create or reuse a session
  let sessionId: string;
  try {
    const sessionResp = await postJson(`${endpoint}/sessions`, token, {
      cwd,
      title: prompt.slice(0, 80),
      metadata: { source: "vscode" }
    });
    if (typeof sessionResp.id !== "string") {
      throw new Error("Control API did not return a session id");
    }
    sessionId = sessionResp.id;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Magi Next: failed to create session — ${msg}`);
    outputChannel?.appendLine(`✗ create session failed: ${msg}`);
    return;
  }

  // Step 2: post the message
  let jobId: string | undefined;
  try {
    const messageResp = await postJson(`${endpoint}/sessions/${sessionId}/messages`, token, {
      content: prompt,
      modelAlias
    });
    jobId = messageResp.jobId;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Magi Next: failed to send message — ${msg}`);
    outputChannel?.appendLine(`✗ send message failed: ${msg}`);
    return;
  }

  outputChannel?.appendLine(`✓ Job started: ${jobId}`);
  outputChannel?.appendLine(`  Stream: ${endpoint}/jobs/${jobId}/events`);
  outputChannel?.appendLine(`  Open in browser to follow: ${endpoint}/panel`);
}

interface ControlResponse {
  id?: string;
  jobId?: string;
  [key: string]: unknown;
}

function postJson(urlString: string, token: string, body: Record<string, unknown>): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const data = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data).toString()
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          resolve({});
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
