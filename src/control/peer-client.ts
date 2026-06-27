/**
 * Client for talking to a remote Magi daemon's control API.
 *
 * Used to dispatch sub-agent tasks across machines: the local agent calls
 * `dispatchToPeer` which creates a session on the peer, posts the prompt,
 * streams the result back, and returns the final assistant message.
 */

import { browseMdns, DiscoveredPeer } from "./mdns.js";
import { ToolPermissionMode } from "../agent/tools.js";

/** Build a reachable base URL for a discovered peer (respect loopback bind). */
export function peerBaseUrl(peer: DiscoveredPeer): string {
  const bind = peer.txt.bind?.trim();
  if (bind === "127.0.0.1" || bind === "::1" || bind === "localhost") {
    return `http://127.0.0.1:${peer.port}`;
  }
  return `http://${peer.address}:${peer.port}`;
}

export interface PeerEndpoint {
  /** e.g. "http://192.168.31.57:8765" */
  baseUrl: string;
  /** Device id for authenticating to the peer (from `magi pair` on the peer). */
  deviceId?: string;
  /** Bearer token for authenticating to the peer. */
  token?: string;
}

export interface PeerDispatchResult {
  sessionId: string;
  jobId: string;
  text: string;
  events: Array<Record<string, unknown>>;
  errorText?: string;
}

/** Resolve a peer name (mDNS instance name or hostname) to a base URL. */
export async function resolvePeerByName(
  name: string,
  options: {
    timeoutMs?: number;
    /** Optional store to look up saved peer credentials before falling back to mDNS. */
    store?: {
      listMcpOAuthTokens(): Array<{
        serverName: string;
        metadata: Record<string, unknown>;
        authServerUrl?: string;
      }>;
    };
  } = {}
): Promise<string | undefined> {
  // If it already looks like a URL, use it directly
  if (/^https?:\/\//.test(name)) return name;
  // If it's host:port, use it directly
  if (/^[\w.-]+:\d+$/.test(name)) return `http://${name}`;
  // Try saved peer credentials first (faster than mDNS, works without multicast)
  if (options.store) {
    const tokens = options.store.listMcpOAuthTokens();
    const saved = tokens.find((t) => t.serverName === `peer:${name}`);
    if (saved) {
      const url = (saved.metadata?.peerUrl as string) ?? saved.authServerUrl;
      if (url) return url;
    }
  }
  // Otherwise, browse mDNS
  const browser = browseMdns({});
  await new Promise((resolve) => setTimeout(resolve, options.timeoutMs ?? 2000));
  const peers = browser.peers();
  browser.stop();
  const match = peers.find(
    (p) =>
      p.instanceName === name ||
      p.instanceName.startsWith(name) ||
      p.hostname.startsWith(name) ||
      p.hostname === `${name}.local.`
  );
  return match ? peerBaseUrl(match) : undefined;
}

/** List all discoverable peers. */
export async function listPeers(timeoutMs = 2500): Promise<DiscoveredPeer[]> {
  const browser = browseMdns({});
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  const peers = browser.peers();
  browser.stop();
  return peers;
}

/** Make an authenticated request to a peer. */
async function peerFetch(
  endpoint: PeerEndpoint,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string> | undefined) ?? {})
  };
  if (endpoint.deviceId) headers["X-Magi-Device-Id"] = endpoint.deviceId;
  if (endpoint.token) headers["Authorization"] = `Bearer ${endpoint.token}`;
  return fetch(`${endpoint.baseUrl}${path}`, { ...init, headers });
}

/**
 * Dispatch a prompt to a remote peer and wait for the final result.
 * Streams events via SSE and aggregates assistant text.
 */
export async function dispatchToPeer(input: {
  peer: PeerEndpoint;
  prompt: string;
  cwd?: string;
  modelAlias?: string;
  permissionMode?: ToolPermissionMode;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<PeerDispatchResult> {
  const events: Array<Record<string, unknown>> = [];

  // 1. Create a session on the peer
  const sessionResp = await peerFetch(input.peer, "/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(input.cwd ? { cwd: input.cwd } : {}),
      title: input.prompt.slice(0, 80),
      metadata: { source: "remote-dispatch" }
    }),
    signal: input.signal
  });
  if (!sessionResp.ok) {
    const text = await sessionResp.text();
    if (sessionResp.status === 401) {
      throw new Error(
        [
          `Peer rejected the request: token is invalid or expired.`,
          ``,
          `Re-pair with the peer:`,
          `  1. On the peer host: 'magi pair <name>'`,
          `  2. Locally: 'magi peers add <name> <url> <device-id> <token>' with the new credentials`
        ].join("\n")
      );
    }
    throw new Error(
      `Peer rejected session create (HTTP ${sessionResp.status}): ${text.slice(0, 200)}`
    );
  }
  const sessionEnvelope = (await sessionResp.json()) as { id?: string; session?: { id: string } };
  const sessionId = sessionEnvelope.id ?? sessionEnvelope.session?.id;
  if (!sessionId) {
    throw new Error(
      `Peer session response missing id: ${JSON.stringify(sessionEnvelope).slice(0, 200)}`
    );
  }

  // 2. Post the message
  const msgResp = await peerFetch(input.peer, `/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: input.prompt,
      // Server reads `model` (not modelAlias). Send both for forward-compat.
      model: input.modelAlias ?? "main",
      modelAlias: input.modelAlias ?? "main",
      permissionMode: input.permissionMode
    }),
    signal: input.signal
  });
  if (!msgResp.ok) {
    const text = await msgResp.text();
    throw new Error(`Peer rejected message post (${msgResp.status}): ${text.slice(0, 200)}`);
  }
  const msg = (await msgResp.json()) as { jobId?: string; message?: string };
  const jobId = msg.jobId;
  // If the peer returned a synchronous message (e.g. provider not configured),
  // surface it directly instead of waiting for SSE.
  if (!jobId && typeof msg.message === "string") {
    return { sessionId, jobId: "", text: msg.message, events: [] };
  }
  if (!jobId) {
    throw new Error(`Peer message response missing jobId: ${JSON.stringify(msg).slice(0, 200)}`);
  }

  // 3. Poll the events endpoint until the job completes.
  // The control server returns {events: [...]} synchronously rather than SSE.
  let assistantText = "";
  let errorText: string | undefined;
  const startTime = Date.now();
  const timeoutMs = 5 * 60 * 1000; // 5 minute hard timeout
  let lastEventCount = 0;
  while (true) {
    if (input.signal?.aborted) throw new Error("Aborted");
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Peer dispatch timed out after ${timeoutMs}ms`);
    }
    // Check job status
    const jobResp = await peerFetch(input.peer, `/jobs/${jobId}`, { signal: input.signal });
    if (!jobResp.ok) {
      // Some servers return 404 until first event; tolerate briefly
      await new Promise((resolve) => setTimeout(resolve, 200));
      continue;
    }
    const jobBody = (await jobResp.json()) as {
      job?: { status?: string; metadata?: Record<string, unknown> };
      status?: string;
      metadata?: Record<string, unknown>;
    };
    // Server wraps the job as { job: {...} }; tolerate either shape.
    const job = jobBody.job ?? jobBody;
    const status = job.status;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      // Fetch all events
      const eventsResp = await peerFetch(input.peer, `/jobs/${jobId}/events`, {
        signal: input.signal
      });
      if (eventsResp.ok) {
        const eventsBody = (await eventsResp.json()) as { events?: Array<Record<string, unknown>> };
        const eventList = eventsBody.events ?? [];
        // Reverse to chronological order (server returns newest first)
        const chronological = [...eventList].reverse();
        for (const evt of chronological) {
          events.push(evt);
          input.onEvent?.(evt);
          const action = evt.action ?? evt.eventName;
          const meta = (evt.metadata ?? {}) as Record<string, unknown>;
          if (action === "agent.text.delta" && typeof meta.text === "string") {
            if (meta.text.length >= assistantText.length) {
              assistantText = meta.text;
            }
          } else if (action === "agent.assistant.message" && typeof meta.text === "string") {
            assistantText = meta.text;
          }
        }
      }
      if (status === "failed") {
        const meta = (job.metadata ?? {}) as Record<string, unknown>;
        errorText = typeof meta.error === "string" ? meta.error : "remote job failed";
      }
      break;
    }
    // Still running — wait briefly and poll again
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return { sessionId, jobId, text: assistantText, events, errorText };
}
