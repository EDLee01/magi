import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { runCli } from "../src/cli.js";
import { requiresMcpApproval } from "../src/mcp/approval.js";
import { McpApprovalRequiredError, McpClient } from "../src/mcp/client.js";
import { McpConnectionManager } from "../src/mcp/connection-manager.js";
import { ensureMagiHome, getMagiPaths } from "../src/paths.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;
let workspace: string | undefined;
let server: http.Server | undefined;
let wsServer: WebSocketServer | undefined;

afterEach(async () => {
  if (wsServer) {
    await closeWebSocketServer(wsServer);
    wsServer = undefined;
  }
  if (server) {
    await closeServer(server);
    server = undefined;
  }
  temp?.cleanup();
  temp = undefined;
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

describe("MCP client and approval", () => {
  it("validates MCP config schema", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "mcp:",
        "  servers:",
        "    local:",
        "      command: node",
        "      args:",
        "        - tests/fixtures/mock-mcp-server.mjs",
        "      env:",
        "        MAGI_MCP_TEST: ok",
        "      approval: dangerous",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.mcp.servers.local.command).toBe("node");
    expect(config.mcp.servers.local.env.MAGI_MCP_TEST).toBe("ok");
  });

  it("validates MCP remote transport config", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "mcp:",
        "  servers:",
        "    remote:",
        "      transport: websocket",
        "      url: ws://127.0.0.1:8765/mcp",
        "      headers:",
        "        authorization: Bearer $MAGI_MCP_TOKEN",
        "      approval: never",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.mcp.servers.remote).toMatchObject({
      transport: "websocket",
      url: "ws://127.0.0.1:8765/mcp",
      headers: { authorization: "Bearer $MAGI_MCP_TOKEN" },
      command: "",
      approval: "never"
    });
  });

  it("rejects remote MCP transport config without a URL", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      "mcp:\n  servers:\n    remote:\n      transport: http\n",
      "utf8"
    );

    expect(() => loadConfig(paths, temp!.env)).toThrow(/mcp\.servers\.remote\.url is required/);
  });

  it("rejects MCP env outside MAGI_*", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      "mcp:\n  servers:\n    bad:\n      command: node\n      env:\n        CLAUDE_TOKEN: bad\n",
      "utf8"
    );

    expect(() => loadConfig(paths, temp!.env)).toThrow(/must use MAGI_\*/);
  });

  it("lists tools from a local MCP server", async () => {
    const client = new McpClient({
      serverName: "local",
      server: {
        command: "node",
        args: [path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")],
        env: {},
        approval: "dangerous"
      }
    });
    try {
      await client.initialize();
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["read_note", "write_note"]);
    } finally {
      client.close();
    }
  });

  it("requires approval for high-risk MCP calls", async () => {
    const server = { command: "node", args: [], env: {}, approval: "dangerous" as const };
    const approval = requiresMcpApproval({
      serverName: "local",
      server,
      toolName: "write_note",
      params: { path: "note.txt" }
    });
    expect(approval).toMatchObject({ risk: "high", toolName: "write_note" });
  });

  it("blocks unapproved high-risk MCP calls", async () => {
    const client = new McpClient({
      serverName: "local",
      server: {
        command: "node",
        args: [path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")],
        env: {},
        approval: "dangerous"
      }
    });
    try {
      await client.initialize();
      await expect(
        client.callTool({ toolName: "write_note", params: { path: "note.txt" } })
      ).rejects.toBeInstanceOf(McpApprovalRequiredError);
    } finally {
      client.close();
    }
  });

  it("lists and reads resources from a local MCP server", async () => {
    const client = new McpClient({
      serverName: "local",
      server: {
        command: "node",
        args: [path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")],
        env: {},
        approval: "dangerous"
      }
    });
    try {
      await client.initialize();
      const resources = await client.listResources();
      expect(resources).toEqual([
        expect.objectContaining({
          uri: "note://alpha",
          name: "Alpha note",
          mimeType: "text/plain"
        })
      ]);
      const content = await client.readResource("note://alpha");
      expect(content.contents).toEqual([
        expect.objectContaining({
          uri: "note://alpha",
          text: "resource text for note://alpha"
        })
      ]);
    } finally {
      client.close();
    }
  });

  it("uses streamable HTTP MCP transport for tools and resources", async () => {
    const headers: Array<string | undefined> = [];
    server = http.createServer(async (request, response) => {
      headers.push(request.headers.authorization);
      const body = await readRequestJson(request);
      writeJson(response, mcpRpcResult(body));
    });
    const url = `${await listen(server)}/mcp`;
    const client = new McpClient({
      serverName: "remote-http",
      server: {
        transport: "http",
        command: "",
        args: [],
        url,
        headers: { authorization: "Bearer $MAGI_MCP_TOKEN" },
        env: {},
        approval: "never"
      },
      env: { MAGI_MCP_TOKEN: "transport-token" }
    });
    try {
      await client.initialize();
      await expect(client.listTools()).resolves.toEqual([
        expect.objectContaining({ name: "read_note" })
      ]);
      const result = await client.callTool({ toolName: "read_note", params: { key: "alpha" } });
      expect(JSON.stringify(result.content)).toContain("called read_note");
      const resource = await client.readResource("note://alpha");
      expect(resource.contents[0]?.text).toBe("resource text for note://alpha");
      expect(headers).toContain("Bearer transport-token");
    } finally {
      client.close();
    }
  });

  it("uses SSE MCP transport for tools and resources", async () => {
    const streams: http.ServerResponse[] = [];
    server = http.createServer(async (request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        streams.push(response);
        response.write(`event: endpoint\ndata: /messages\n\n`);
        return;
      }
      expect(request.url).toBe("/messages");
      const body = await readRequestJson(request);
      const stream = streams[0];
      if (!stream) {
        response.writeHead(409);
        response.end("SSE stream is not connected");
        return;
      }
      response.writeHead(202);
      response.end();
      stream.write(`event: message\ndata: ${JSON.stringify(mcpRpcResult(body))}\n\n`);
    });
    const url = `${await listen(server)}/sse`;
    const client = new McpClient({
      serverName: "remote-sse",
      server: {
        transport: "sse",
        command: "",
        args: [],
        url,
        env: {},
        approval: "never"
      }
    });
    try {
      await client.initialize();
      await expect(client.listTools()).resolves.toEqual([
        expect.objectContaining({ name: "read_note" })
      ]);
      const result = await client.callTool({ toolName: "read_note", params: { key: "alpha" } });
      expect(JSON.stringify(result.content)).toContain("called read_note");
      const resource = await client.readResource("note://alpha");
      expect(resource.contents[0]?.text).toBe("resource text for note://alpha");
    } finally {
      client.close();
    }
  });

  it("uses WebSocket MCP transport for tools and resources", async () => {
    server = http.createServer();
    wsServer = new WebSocketServer({ server });
    wsServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString("utf8")) as McpTestRequest;
        socket.send(JSON.stringify(mcpRpcResult(request)));
      });
    });
    const httpUrl = await listen(server);
    const url = httpUrl.replace(/^http:/, "ws:");
    const client = new McpClient({
      serverName: "remote-websocket",
      server: {
        transport: "websocket",
        command: "",
        args: [],
        url,
        env: {},
        approval: "never"
      }
    });
    try {
      await client.initialize();
      await expect(client.listTools()).resolves.toEqual([
        expect.objectContaining({ name: "read_note" })
      ]);
      const result = await client.callTool({ toolName: "read_note", params: { key: "alpha" } });
      expect(JSON.stringify(result.content)).toContain("called read_note");
      const resource = await client.readResource("note://alpha");
      expect(resource.contents[0]?.text).toBe("resource text for note://alpha");
    } finally {
      client.close();
    }
  });

  it("lists configured MCP server tools through CLI", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "mcp:",
        "  servers:",
        "    local:",
        "      command: node",
        `      args: ["${path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")}"]`,
        "      approval: dangerous",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(["mcp", "list", "local"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("read_note");
    expect(result.stdout).toContain("write_note");
  });

  it("lists and reads configured MCP resources through CLI", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "mcp:",
        "  servers:",
        "    local:",
        "      command: node",
        `      args: ["${path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")}"]`,
        "      approval: dangerous",
        ""
      ].join("\n"),
      "utf8"
    );

    const resources = await runCli(["mcp", "resources", "local"], temp.env, process.cwd());
    expect(resources.exitCode).toBe(0);
    expect(resources.stdout).toContain("note://alpha");
    expect(resources.stdout).toContain("Alpha note");

    const read = await runCli(
      ["mcp", "read-resource", "local", "note://alpha"],
      temp.env,
      process.cwd()
    );
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain("resource text for note://alpha");
  });

  it("reconnects and retries once when an MCP session expires", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-mcp-expire-"));
    const marker = path.join(workspace, "expired.once");
    const client = new McpClient({
      serverName: "local",
      server: {
        command: "node",
        args: [path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")],
        env: { MAGI_MCP_EXPIRE_ONCE_FILE: marker },
        approval: "never"
      }
    });
    try {
      await client.initialize();
      const result = await client.callTool({ toolName: "read_note", params: { key: "alpha" } });
      expect(JSON.stringify(result.content)).toContain("called read_note");
      const resource = await client.readResource("note://alpha");
      expect(JSON.stringify(resource.contents)).toContain("resource text for note://alpha");
    } finally {
      client.close();
    }
  });

  it("deduplicates concurrent MCP connections and reuses initialized clients", async () => {
    const manager = new McpConnectionManager({
      servers: {
        local: {
          command: "node",
          args: [path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")],
          env: {},
          approval: "never"
        }
      }
    });
    try {
      const [first, second] = await Promise.all([
        manager.connect("local"),
        manager.connect("local")
      ]);
      expect(first).toBe(second);
      await expect(first.listTools()).resolves.toHaveLength(2);
      await expect(manager.connect("local")).resolves.toBe(first);
      expect(manager.connectedServerNames()).toEqual(["local"]);
    } finally {
      manager.disconnectAll();
    }
  });

  it("removes disconnected MCP clients and reconnects on demand", async () => {
    const manager = new McpConnectionManager({
      servers: {
        local: {
          command: "node",
          args: [path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")],
          env: {},
          approval: "never"
        }
      }
    });
    try {
      const first = await manager.connect("local");
      manager.disconnect("local");
      expect(manager.connectedServerNames()).toEqual([]);

      const second = await manager.connect("local");
      expect(second).not.toBe(first);
      await expect(second.listTools()).resolves.toHaveLength(2);
    } finally {
      manager.disconnectAll();
    }
  });

  it("closes in-flight MCP connections during disconnectAll", async () => {
    const manager = new McpConnectionManager({
      servers: {
        local: {
          command: "node",
          args: [path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")],
          env: { MAGI_MCP_INIT_DELAY_MS: "100" },
          approval: "never"
        }
      }
    });
    const connecting = manager.connect("local");
    manager.disconnectAll();

    await expect(connecting).rejects.toThrow(/closed/);
    expect(manager.connectedServerNames()).toEqual([]);
  });
});

interface McpTestRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

function mcpRpcResult(request: McpTestRequest): Record<string, unknown> {
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "transport-test", version: "0.1.0" },
        capabilities: { tools: {}, resources: {} }
      }
    };
  }
  if (request.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [{ name: "read_note", description: "Read a note", inputSchema: { type: "object" } }]
      }
    };
  }
  if (request.method === "tools/call") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: `called ${String(request.params?.name)}` }]
      }
    };
  }
  if (request.method === "resources/read") {
    const uri = String(request.params?.uri);
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        contents: [{ uri, mimeType: "text/plain", text: `resource text for ${uri}` }]
      }
    };
  }
  return {
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: "method not found" }
  };
}

async function readRequestJson(request: http.IncomingMessage): Promise<McpTestRequest> {
  let raw = "";
  for await (const chunk of request) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
  }
  return JSON.parse(raw) as McpTestRequest;
}

function writeJson(response: http.ServerResponse, body: Record<string, unknown>): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

it("validates websocket-ide transport config", () => {
  temp = makeTempRoot();
  const paths = getMagiPaths(temp.env);
  ensureMagiHome(paths);
  writeFileSync(
    paths.configFile,
    [
      "mcp:",
      "  servers:",
      "    ide:",
      "      transport: websocket-ide",
      "      url: ws://127.0.0.1:9000/mcp-ide",
      "      headers:",
      "        x-ide-token: $MAGI_IDE_TOKEN",
      "      approval: never",
      ""
    ].join("\n"),
    "utf8"
  );

  const config = loadConfig(paths, temp.env);
  expect(config.mcp.servers.ide).toMatchObject({
    transport: "websocket-ide",
    url: "ws://127.0.0.1:9000/mcp-ide",
    headers: { "x-ide-token": "$MAGI_IDE_TOKEN" },
    command: "",
    approval: "never"
  });
});

it("rejects invalid websocket-ide transport", () => {
  temp = makeTempRoot();
  const paths = getMagiPaths(temp.env);
  ensureMagiHome(paths);
  writeFileSync(
    paths.configFile,
    "mcp:\n  servers:\n    bad:\n      transport: websocket-invalid\n      url: ws://localhost\n",
    "utf8"
  );

  expect(() => loadConfig(paths, temp!.env)).toThrow(
    /must be stdio, http, sse, websocket, or websocket-ide/
  );
});
