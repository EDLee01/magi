import readline from "node:readline";
import { existsSync, writeFileSync } from "node:fs";

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    const delayMs = Number(process.env.MAGI_MCP_INIT_DELAY_MS ?? 0);
    setTimeout(() => {
      send(request.id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "mock-mcp", version: "0.1.0" },
        capabilities: { tools: {} }
      });
    }, Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0);
    return;
  }
  if (request.method === "tools/list") {
    send(request.id, {
      tools: [
        { name: "read_note", description: "Read a note", inputSchema: { type: "object" } },
        { name: "write_note", description: "Write a note", inputSchema: { type: "object" } }
      ]
    });
    return;
  }
  if (request.method === "tools/call") {
    if (shouldExpireOnce()) {
      sendError(request.id, "session expired", -32001);
      return;
    }
    if (process.env.MAGI_MCP_AUTH_REQUIRED === "1") {
      sendError(request.id, "auth required", -32042);
      return;
    }
    send(request.id, {
      content: [{ type: "text", text: `called ${request.params.name}` }]
    });
    return;
  }
  if (request.method === "resources/list") {
    send(request.id, {
      resources: [
        { uri: "note://alpha", name: "Alpha note", description: "A note exposed as a resource", mimeType: "text/plain" }
      ]
    });
    return;
  }
  if (request.method === "resources/read") {
    if (shouldExpireOnce()) {
      sendError(request.id, "session expired", -32001);
      return;
    }
    send(request.id, {
      contents: [
        { uri: request.params.uri, mimeType: "text/plain", text: `resource text for ${request.params.uri}` }
      ]
    });
    return;
  }
  sendError(request.id, "method not found");
});

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id, message, code = -32601) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function shouldExpireOnce() {
  const marker = process.env.MAGI_MCP_EXPIRE_ONCE_FILE;
  if (!marker || existsSync(marker)) {
    return false;
  }
  writeFileSync(marker, "expired", "utf8");
  return true;
}
