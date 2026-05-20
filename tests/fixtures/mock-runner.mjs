import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send(request.id, {
      runner: "magi-runner",
      version: "0.1.0-test",
      capabilities: ["ping", "echo", "process.run", "pty.smoke", "file.applyPatch"]
    });
    return;
  }
  if (request.method === "ping") {
    send(request.id, { ok: true });
    return;
  }
  if (request.method === "echo") {
    send(request.id, { text: request.params.text });
    return;
  }
  if (request.method === "process.run") {
    const timedOut = request.params.timeoutMs === 1;
    send(request.id, {
      command: request.params.command,
      cwd: request.params.cwd,
      exitCode: timedOut ? null : 0,
      stdout: timedOut ? "" : "mock stdout\n",
      stderr: "",
      timedOut
    });
    return;
  }
  if (request.method === "pty.smoke") {
    send(request.id, {
      ok: true,
      stdout: "magi-pty-ok",
      stderr: ""
    });
    return;
  }
  if (request.method === "file.applyPatch") {
    if (!request.params.approved) {
      sendError(request.id, "file.applyPatch requires approved=true");
      return;
    }
    send(request.id, {
      path: request.params.filePath,
      diff: `--- a/${request.params.filePath}\n+++ b/${request.params.filePath}\n@@\n+${request.params.content}\n`,
      approved: true,
      auditEvent: {
        action: "runner.file.applyPatch",
        target: request.params.filePath,
        metadata: {
          path: request.params.filePath,
          approved: true
        }
      }
    });
    return;
  }
  sendError(request.id, "method not found");
});

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { message } })}\n`);
}
