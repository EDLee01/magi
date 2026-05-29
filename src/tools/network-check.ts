import { spawnSync } from "node:child_process";
import { Socket } from "node:net";

export interface NetworkCheckResult {
  target: string;
  reachable: boolean;
  latencyMs?: number;
  error?: string;
  resolvedIps?: string[];
}
export const NetworkCheckInputSchema = {
  type: "object",
  properties: { host: { type: "string" }, port: { type: "number" }, timeoutMs: { type: "number" } },
  required: ["host"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseNetworkCheckInput(input: Record<string, unknown>): {
  host: string;
  port?: number;
  timeoutMs: number;
} {
  return {
    host: typeof input.host === "string" ? input.host : "",
    port: typeof input.port === "number" ? input.port : undefined,
    timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : 5000
  };
}

export async function executeNetworkCheck(input: {
  host: string;
  port?: number;
  timeoutMs: number;
}): Promise<NetworkCheckResult> {
  const result: NetworkCheckResult = {
    target: input.port ? `${input.host}:${input.port}` : input.host,
    reachable: false
  };

  if (input.port) {
    // TCP port check
    return new Promise((resolve) => {
      const socket = new Socket();
      socket.setTimeout(input.timeoutMs);
      socket.on("connect", () => {
        socket.destroy();
        resolve({ ...result, reachable: true });
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve({ ...result, reachable: false, error: "Connection timed out" });
      });
      socket.on("error", (err) => {
        socket.destroy();
        resolve({ ...result, reachable: false, error: err.message });
      });
      socket.connect(input.port!, input.host);
    });
  }

  // Ping check using spawnSync to avoid shell injection
  try {
    const start = Date.now();
    const pingResult = spawnSync(
      "ping",
      ["-c", "1", "-W", String(Math.ceil(input.timeoutMs / 1000)), input.host],
      { encoding: "utf8", timeout: input.timeoutMs + 1000 }
    );
    if (pingResult.status === 0) {
      return { ...result, reachable: true, latencyMs: Date.now() - start };
    } else {
      return { ...result, reachable: false, error: "Host unreachable" };
    }
  } catch {
    return { ...result, reachable: false, error: "Host unreachable" };
  }
}

export function formatNetworkCheckResult(result: NetworkCheckResult): string {
  const status = result.reachable ? "REACHABLE" : "UNREACHABLE";
  const parts = [`${result.target}: ${status}`];
  if (result.latencyMs !== undefined) parts.push(`Latency: ${result.latencyMs}ms`);
  if (result.error) parts.push(`Error: ${result.error}`);
  return parts.join("\n");
}
