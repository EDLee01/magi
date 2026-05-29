import { McpServerConfig } from "../config.js";
import { McpClient } from "./client.js";

export interface McpConnectionManagerInput {
  servers: Record<string, McpServerConfig>;
  env?: NodeJS.ProcessEnv;
  /** If set, run a periodic health check every N ms. Failure triggers reconnect. */
  healthCheckIntervalMs?: number;
  /** Callback when a server reconnects (for telemetry). */
  onReconnect?: (serverName: string, success: boolean) => void;
  /** Look up an OAuth bearer token for the server, if any. */
  tokenLookup?: (serverName: string) => string | undefined;
  /** Refresh OAuth token after 401. Should return the new access token. */
  tokenRefresh?: (serverName: string) => Promise<string | undefined>;
}

export class McpConnectionManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly connecting = new Map<string, PendingConnection>();
  private healthTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly input: McpConnectionManagerInput) {
    if (input.healthCheckIntervalMs && input.healthCheckIntervalMs > 0) {
      this.healthTimer = setInterval(() => {
        void this.runHealthCheck();
      }, input.healthCheckIntervalMs);
      // Don't keep the process alive just for health checks
      this.healthTimer.unref?.();
    }
  }

  async runHealthCheck(): Promise<
    Array<{ serverName: string; healthy: boolean; reconnected: boolean }>
  > {
    const results: Array<{ serverName: string; healthy: boolean; reconnected: boolean }> = [];
    for (const [name, client] of this.clients) {
      const healthy = await client.ping().catch(() => false);
      let reconnected = false;
      if (!healthy) {
        try {
          await client.reconnect();
          reconnected = true;
          this.input.onReconnect?.(name, true);
        } catch {
          // Reconnect failed — drop the client
          client.close();
          this.clients.delete(name);
          this.input.onReconnect?.(name, false);
        }
      }
      results.push({ serverName: name, healthy, reconnected });
    }
    return results;
  }

  async connect(serverName: string): Promise<McpClient> {
    const existing = this.clients.get(serverName);
    if (existing) {
      return existing;
    }

    const pending = this.connecting.get(serverName);
    if (pending) {
      return pending.promise;
    }

    const server = this.input.servers[serverName];
    if (!server) {
      throw new Error(`MCP server is not configured: ${serverName}`);
    }

    // If an OAuth token is stored for this server, inject it as a Bearer header.
    const token = this.input.tokenLookup?.(serverName);
    const serverWithAuth = token
      ? { ...server, headers: { ...(server.headers ?? {}), Authorization: `Bearer ${token}` } }
      : server;

    const client = new McpClient({
      serverName,
      server: serverWithAuth,
      env: this.input.env,
      onDisconnect: () => {
        if (this.clients.get(serverName) === client) {
          this.clients.delete(serverName);
        }
      },
      onUnauthorized: this.input.tokenRefresh
        ? async () => this.input.tokenRefresh!(serverName)
        : undefined
    });

    let connection: PendingConnection;
    const promise = Promise.resolve()
      .then(async () => {
        await client.initialize();
        if (this.connecting.get(serverName) !== connection) {
          client.close();
          throw new Error(
            `MCP connection to ${serverName} was closed before initialization completed`
          );
        }
        this.clients.set(serverName, client);
        return client;
      })
      .catch((error) => {
        client.close();
        throw error;
      })
      .finally(() => {
        if (this.connecting.get(serverName) === connection) {
          this.connecting.delete(serverName);
        }
      });

    connection = { client, promise };
    this.connecting.set(serverName, connection);
    return promise;
  }

  disconnect(serverName: string): void {
    const pending = this.connecting.get(serverName);
    if (pending) {
      pending.client.close();
      this.connecting.delete(serverName);
    }
    const client = this.clients.get(serverName);
    if (client) {
      client.close();
      this.clients.delete(serverName);
    }
    this.connecting.delete(serverName);
  }

  disconnectAll(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    for (const [serverName, pending] of this.connecting) {
      pending.client.close();
      this.connecting.delete(serverName);
    }
    for (const [serverName, client] of this.clients) {
      client.close();
      this.clients.delete(serverName);
    }
    this.connecting.clear();
  }

  connectedServerNames(): string[] {
    return [...this.clients.keys()];
  }
}

interface PendingConnection {
  client: McpClient;
  promise: Promise<McpClient>;
}
