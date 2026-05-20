"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const node_url_1 = require("node:url");
/**
 * Magi Next VS Code extension entrypoint.
 *
 * Communicates with magi-next via the control HTTP API. Run `magi control start`
 * in a terminal first (or set MAGI_AUTOSTART_CONTROL=1).
 */
let outputChannel;
function activate(context) {
    outputChannel = vscode.window.createOutputChannel("Magi Next");
    outputChannel.appendLine("Magi Next extension activated.");
    context.subscriptions.push(vscode.commands.registerCommand("magi-next.askWithSelection", () => askWithSelection()), vscode.commands.registerCommand("magi-next.askWithFile", (uri) => askWithFile(uri)), vscode.commands.registerCommand("magi-next.openSession", () => openSession()), vscode.commands.registerCommand("magi-next.setControlEndpoint", () => configureEndpoint()));
}
function deactivate() {
    outputChannel?.dispose();
}
async function askWithSelection() {
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
    if (!userPrompt)
        return;
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
async function askWithFile(uri) {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
        vscode.window.showWarningMessage("No file selected.");
        return;
    }
    const userPrompt = await vscode.window.showInputBox({
        prompt: `Ask Magi about ${vscode.workspace.asRelativePath(target)}`,
        placeHolder: "e.g. explain this file, find issues, suggest improvements"
    });
    if (!userPrompt)
        return;
    const relPath = vscode.workspace.asRelativePath(target);
    const prompt = `${userPrompt}\n\nFile: @${relPath}`;
    await sendToMagi(prompt);
}
async function openSession() {
    const config = vscode.workspace.getConfiguration("magiNext");
    const endpoint = config.get("controlEndpoint", "http://127.0.0.1:8765");
    vscode.env.openExternal(vscode.Uri.parse(`${endpoint}/panel`));
}
async function configureEndpoint() {
    const config = vscode.workspace.getConfiguration("magiNext");
    const current = config.get("controlEndpoint", "http://127.0.0.1:8765");
    const endpoint = await vscode.window.showInputBox({
        prompt: "Magi Next control API endpoint",
        value: current
    });
    if (!endpoint)
        return;
    await config.update("controlEndpoint", endpoint, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Magi Next endpoint set to ${endpoint}`);
}
async function sendToMagi(prompt) {
    const config = vscode.workspace.getConfiguration("magiNext");
    const endpoint = config.get("controlEndpoint", "http://127.0.0.1:8765");
    const token = config.get("controlToken", "");
    const modelAlias = config.get("modelAlias", "auto");
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    outputChannel?.show(true);
    outputChannel?.appendLine(`\n→ Sending to Magi Next (${endpoint}, model=${modelAlias})`);
    outputChannel?.appendLine(`  cwd: ${cwd}`);
    // Step 1: create or reuse a session
    let sessionId;
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
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Magi Next: failed to create session — ${msg}`);
        outputChannel?.appendLine(`✗ create session failed: ${msg}`);
        return;
    }
    // Step 2: post the message
    let jobId;
    try {
        const messageResp = await postJson(`${endpoint}/sessions/${sessionId}/messages`, token, {
            content: prompt,
            modelAlias
        });
        jobId = messageResp.jobId;
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Magi Next: failed to send message — ${msg}`);
        outputChannel?.appendLine(`✗ send message failed: ${msg}`);
        return;
    }
    outputChannel?.appendLine(`✓ Job started: ${jobId}`);
    outputChannel?.appendLine(`  Stream: ${endpoint}/jobs/${jobId}/events`);
    outputChannel?.appendLine(`  Open in browser to follow: ${endpoint}/panel`);
}
function postJson(urlString, token, body) {
    return new Promise((resolve, reject) => {
        const url = new node_url_1.URL(urlString);
        const isHttps = url.protocol === "https:";
        const lib = isHttps ? https : http;
        const data = JSON.stringify(body);
        const headers = {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data).toString()
        };
        if (token)
            headers["Authorization"] = `Bearer ${token}`;
        const req = lib.request({
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: "POST",
            headers
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                if (!res.statusCode || res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
                    return;
                }
                try {
                    resolve(text ? JSON.parse(text) : {});
                }
                catch {
                    resolve({});
                }
            });
        });
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}
//# sourceMappingURL=extension.js.map