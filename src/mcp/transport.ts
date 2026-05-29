import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import WebSocket from "ws";

import { McpServerConfig } from "../config.js";

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface McpTransport {
  ready(): Promise<void>;
  send(message: McpJsonRpcRequest): Promise<void>;
  close(): void;
}

export interface McpTransportCallbacks {
  onMessage(message: unknown): void;
  onError(error: Error): void;
  onDisconnect(): void;
}

/**
 * Thrown when an HTTP-based MCP server returns 401 Unauthorized.
 * Callers can catch this and trigger an OAuth refresh/auth flow.
 */
export class McpUnauthorizedError extends Error {
  constructor(
    public readonly serverName: string,
    public readonly wwwAuthenticate: string | null,
    public readonly body: string
  ) {
    super(`MCP server ${serverName} returned 401 Unauthorized`);
    this.name = "McpUnauthorizedError";
  }
}

export function createMcpTransport(input: {
  serverName: string;
  server: McpServerConfig;
  env?: NodeJS.ProcessEnv;
  callbacks: McpTransportCallbacks;
}): McpTransport {
  const transport = input.server.transport ?? "stdio";
  if (transport === "stdio") {
    return new StdioMcpTransport(input);
  }
  if (transport === "http") {
    return new HttpMcpTransport(input);
  }
  if (transport === "sse") {
    return new SseMcpTransport(input);
  }
  if (transport === "websocket") {
    return new WebSocketMcpTransport(input);
  }
  if (transport === "websocket-ide") {
    return new WebSocketIdeMcpTransport(input);
  }
  throw new Error(`Unsupported MCP transport for ${input.serverName}: ${transport}`);
}

class StdioMcpTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: readline.Interface;
  private closed = false;

  constructor(
    private readonly input: {
      serverName: string;
      server: McpServerConfig;
      env?: NodeJS.ProcessEnv;
      callbacks: McpTransportCallbacks;
    }
  ) {
    if (!input.server.command) {
      throw new Error(`MCP stdio server ${input.serverName} requires command`);
    }
    this.child = spawn(input.server.command, input.server.args, {
      env: { ...process.env, ...input.env, ...input.server.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => input.callbacks.onMessage(parseJsonLine(line)));
    this.child.on("error", (error) => {
      if (!this.closed) {
        input.callbacks.onError(error);
      }
    });
    this.child.on("exit", (code) => {
      if (!this.closed) {
        input.callbacks.onDisconnect();
        input.callbacks.onError(
          new Error(`MCP server ${input.serverName} exited with code ${code}`)
        );
      }
    });
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  send(message: McpJsonRpcRequest): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(`MCP stdio server ${this.input.serverName} is closed`));
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8", (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lines.close();
    this.child.removeAllListeners("error");
    this.child.removeAllListeners("exit");
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }
}

class HttpMcpTransport implements McpTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private closed = false;

  constructor(
    private readonly input: {
      serverName: string;
      server: McpServerConfig;
      env?: NodeJS.ProcessEnv;
      callbacks: McpTransportCallbacks;
    }
  ) {
    if (!input.server.url) {
      throw new Error(`MCP HTTP server ${input.serverName} requires url`);
    }
    this.url = input.server.url;
    this.headers = buildHeaders(input.server.headers, input.env);
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  async send(message: McpJsonRpcRequest): Promise<void> {
    if (this.closed) {
      throw new Error(`MCP HTTP server ${this.input.serverName} is closed`);
    }
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        ...this.headers,
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify(message)
    });
    await emitHttpResponse(response, this.input.serverName, this.input.callbacks);
  }

  close(): void {
    this.closed = true;
  }
}

class SseMcpTransport implements McpTransport {
  private readonly url: string;
  private postUrl: string;
  private readonly headers: Record<string, string>;
  private readonly controller = new AbortController();
  private readonly connectedPromise: Promise<void>;
  private resolveConnected: (() => void) | undefined;
  private rejectConnected: ((error: Error) => void) | undefined;
  private buffer = "";
  private closed = false;

  constructor(
    private readonly input: {
      serverName: string;
      server: McpServerConfig;
      env?: NodeJS.ProcessEnv;
      callbacks: McpTransportCallbacks;
    }
  ) {
    if (!input.server.url) {
      throw new Error(`MCP SSE server ${input.serverName} requires url`);
    }
    this.url = input.server.url;
    this.postUrl = input.server.url;
    this.headers = buildHeaders(input.server.headers, input.env);
    this.connectedPromise = new Promise((resolve, reject) => {
      this.resolveConnected = resolve;
      this.rejectConnected = reject;
    });
    void this.open();
  }

  ready(): Promise<void> {
    return this.connectedPromise;
  }

  async send(message: McpJsonRpcRequest): Promise<void> {
    if (this.closed) {
      throw new Error(`MCP SSE server ${this.input.serverName} is closed`);
    }
    await this.ready();
    const response = await fetch(this.postUrl, {
      method: "POST",
      headers: {
        ...this.headers,
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify(message)
    });
    await emitHttpResponse(response, this.input.serverName, this.input.callbacks, {
      allowEmpty: true
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.controller.abort();
  }

  private async open(): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: "GET",
        headers: {
          ...this.headers,
          accept: "text/event-stream"
        },
        signal: this.controller.signal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (response.status === 401) {
          throw new McpUnauthorizedError(
            this.input.serverName,
            response.headers.get("www-authenticate"),
            body
          );
        }
        throw new Error(
          `MCP SSE server ${this.input.serverName} returned ${response.status}: ${body}`
        );
      }
      if (!response.body) {
        throw new Error(`MCP SSE server ${this.input.serverName} returned no event stream`);
      }
      void this.readEvents(response.body);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.rejectConnected?.(normalized);
      if (!this.closed) {
        this.input.callbacks.onError(normalized);
      }
    }
  }

  private async readEvents(body: ReadableStream<Uint8Array>): Promise<void> {
    try {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          this.consume(decoder.decode(value, { stream: true }));
        }
      }
      if (!this.closed) {
        this.input.callbacks.onDisconnect();
        this.input.callbacks.onError(
          new Error(`MCP SSE server ${this.input.serverName} disconnected`)
        );
      }
    } catch (error) {
      if (!this.closed) {
        this.input.callbacks.onDisconnect();
        this.input.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) {
        return;
      }
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.handleSseFrame(frame);
    }
  }

  private handleSseFrame(frame: string): void {
    const event = readSseEvent(frame);
    if (!event || !event.data.trim()) {
      return;
    }
    if (event.name === "endpoint") {
      this.postUrl = new URL(event.data.trim(), this.url).toString();
      this.resolveConnected?.();
      return;
    }
    this.resolveConnected?.();
    this.input.callbacks.onMessage(parseJsonLine(event.data));
  }
}

class WebSocketMcpTransport implements McpTransport {
  private readonly socket: WebSocket;
  private readonly openPromise: Promise<void>;
  private closed = false;

  constructor(
    private readonly input: {
      serverName: string;
      server: McpServerConfig;
      env?: NodeJS.ProcessEnv;
      callbacks: McpTransportCallbacks;
    }
  ) {
    if (!input.server.url) {
      throw new Error(`MCP WebSocket server ${input.serverName} requires url`);
    }
    this.socket = new WebSocket(input.server.url, {
      headers: buildHeaders(input.server.headers, input.env)
    });
    this.openPromise = new Promise((resolve, reject) => {
      let settled = false;
      this.socket.once("open", () => {
        settled = true;
        resolve();
      });
      this.socket.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        if (!this.closed) {
          input.callbacks.onError(error);
        }
      });
    });
    this.socket.on("message", (data) => {
      input.callbacks.onMessage(parseJsonLine(data.toString("utf8")));
    });
    this.socket.on("close", () => {
      if (!this.closed) {
        input.callbacks.onDisconnect();
        input.callbacks.onError(new Error(`MCP WebSocket server ${input.serverName} disconnected`));
      }
    });
  }

  ready(): Promise<void> {
    return this.openPromise;
  }

  async send(message: McpJsonRpcRequest): Promise<void> {
    if (this.closed) {
      throw new Error(`MCP WebSocket server ${this.input.serverName} is closed`);
    }
    await this.ready();
    return new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(message), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate();
      return;
    }
    this.socket.close();
  }
}

class WebSocketIdeMcpTransport implements McpTransport {
  private readonly socket: WebSocket;
  private readonly openPromise: Promise<void>;
  private closed = false;

  constructor(
    private readonly input: {
      serverName: string;
      server: McpServerConfig;
      env?: NodeJS.ProcessEnv;
      callbacks: McpTransportCallbacks;
    }
  ) {
    if (!input.server.url) {
      throw new Error(`MCP WebSocket-IDE server ${input.serverName} requires url`);
    }
    this.socket = new WebSocket(input.server.url, {
      headers: buildHeaders(input.server.headers, input.env)
    });
    this.openPromise = new Promise((resolve, reject) => {
      let settled = false;
      this.socket.once("open", () => {
        settled = true;
        resolve();
      });
      this.socket.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        if (!this.closed) {
          input.callbacks.onError(error);
        }
      });
    });
    this.socket.on("message", (data) => {
      this.handleMessage(data.toString("utf8"));
    });
    this.socket.on("close", () => {
      if (!this.closed) {
        input.callbacks.onDisconnect();
        input.callbacks.onError(
          new Error(`MCP WebSocket-IDE server ${input.serverName} disconnected`)
        );
      }
    });
  }

  ready(): Promise<void> {
    return this.openPromise;
  }

  async send(message: McpJsonRpcRequest): Promise<void> {
    if (this.closed) {
      throw new Error(`MCP WebSocket-IDE server ${this.input.serverName} is closed`);
    }
    await this.ready();
    return new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(message), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate();
      return;
    }
    this.socket.close();
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      // IDE-specific message types
      if (message.type === "file-sync") {
        this.input.callbacks.onMessage({
          jsonrpc: "2.0",
          method: "ide/fileSync",
          params: message.data
        });
        return;
      }

      if (message.type === "diagnostics") {
        this.input.callbacks.onMessage({
          jsonrpc: "2.0",
          method: "ide/diagnostics",
          params: message.data
        });
        return;
      }

      this.input.callbacks.onMessage(message);
    } catch (error) {
      if (!this.closed) {
        this.input.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

async function emitHttpResponse(
  response: Response,
  serverName: string,
  callbacks: McpTransportCallbacks,
  options: { allowEmpty?: boolean } = {}
): Promise<void> {
  const body = await response.text();
  if (!response.ok) {
    if (response.status === 401) {
      throw new McpUnauthorizedError(serverName, response.headers.get("www-authenticate"), body);
    }
    throw new Error(`MCP HTTP server ${serverName} returned ${response.status}: ${body}`);
  }
  if (!body.trim()) {
    if (options.allowEmpty) {
      return;
    }
    throw new Error(`MCP HTTP server ${serverName} returned an empty response`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    for (const message of parseSseText(body)) {
      callbacks.onMessage(message);
    }
    return;
  }
  callbacks.onMessage(JSON.parse(body));
}

function buildHeaders(
  headers: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    result[key] = value.replace(
      /\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_match, name: string) => env?.[name] ?? process.env[name] ?? ""
    );
  }
  return result;
}

function parseJsonLine(line: string): unknown {
  return JSON.parse(line);
}

function parseSseText(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const event = readSseEvent(frame);
    if (event?.data.trim() && event.name !== "endpoint") {
      messages.push(JSON.parse(event.data));
    }
  }
  return messages;
}

function readSseEvent(frame: string): { name: string; data: string } | undefined {
  let name = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      name = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (data.length === 0) {
    return undefined;
  }
  return { name, data: data.join("\n") };
}
