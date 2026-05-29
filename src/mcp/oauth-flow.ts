/**
 * High-level OAuth orchestrator: glues the OAuth client, callback server,
 * and SessionStore token persistence together.
 *
 * Usage:
 *
 *   const result = await runOAuthFlow({
 *     serverName: "linear",
 *     authServerUrl: "https://auth.linear.app",
 *     scope: "read",
 *     store
 *   });
 *
 *   // Browser opens, user authorizes, control returns here with the token saved.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

import { SessionStore } from "../session-store.js";
import {
  buildAuthorizationRequest,
  discoverOAuthMetadata,
  exchangeCodeForToken,
  OAuthMetadata,
  refreshAccessToken,
  registerOAuthClient
} from "./oauth.js";
import { startOAuthCallbackServer } from "./oauth-callback.js";

export interface RunOAuthFlowInput {
  serverName: string;
  authServerUrl: string;
  store: SessionStore;
  scope?: string;
  /** Static client_id. If omitted, dynamic registration (RFC 7591) is attempted. */
  clientId?: string;
  clientSecret?: string;
  /** Skip auto-launching the browser (for headless testing) */
  noBrowser?: boolean;
  /** Called once we know the authorization URL (e.g., to print it before opening browser). */
  onAuthorizationUrl?: (url: string) => void;
}

export interface RunOAuthFlowResult {
  serverName: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
}

export async function runOAuthFlow(input: RunOAuthFlowInput): Promise<RunOAuthFlowResult> {
  const metadata = await discoverOAuthMetadata(input.authServerUrl);

  // Start the local callback server first so we know the redirect URI
  const callback = await startOAuthCallbackServer({});
  try {
    let clientId = input.clientId;
    let clientSecret = input.clientSecret;

    if (!clientId) {
      if (!metadata.registration_endpoint) {
        throw new Error(
          `OAuth server at ${input.authServerUrl} does not support Dynamic Client Registration. ` +
            `Configure a static client_id in mcp.servers.${input.serverName}.oauth.clientId`
        );
      }
      const registered = await registerOAuthClient({
        registrationEndpoint: metadata.registration_endpoint,
        redirectUri: callback.redirectUri,
        clientName: `Magi Next (${input.serverName})`,
        scope: input.scope
      });
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
    }

    const auth = buildAuthorizationRequest({
      metadata,
      client: {
        clientId: clientId!,
        clientSecret,
        redirectUri: callback.redirectUri,
        scope: input.scope
      }
    });

    input.onAuthorizationUrl?.(auth.authorizationUrl);

    if (!input.noBrowser) {
      openBrowser(auth.authorizationUrl);
    }

    const callbackResult = await callback.result;
    if (callbackResult.state !== auth.state) {
      throw new Error("OAuth callback state mismatch (possible CSRF attempt)");
    }

    const token = await exchangeCodeForToken({
      metadata,
      client: {
        clientId: clientId!,
        clientSecret,
        redirectUri: callback.redirectUri,
        scope: input.scope
      },
      code: callbackResult.code,
      codeVerifier: auth.codeVerifier
    });

    const expiresAt = token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000).toISOString()
      : undefined;

    input.store.upsertMcpOAuthToken({
      serverName: input.serverName,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenType: token.token_type,
      expiresAt,
      scope: token.scope ?? input.scope,
      authServerUrl: input.authServerUrl,
      clientId,
      metadata: { clientSecret: clientSecret ? "[REDACTED]" : undefined }
    });

    return {
      serverName: input.serverName,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt,
      scope: token.scope ?? input.scope
    };
  } finally {
    callback.close();
  }
}

/**
 * Refresh a stored token if it has a refresh_token. Updates the stored record.
 * Returns the new access token, or undefined if refresh is not possible.
 */
export async function refreshStoredToken(input: {
  serverName: string;
  store: SessionStore;
}): Promise<string | undefined> {
  const stored = input.store.getMcpOAuthToken(input.serverName);
  if (!stored || !stored.refreshToken || !stored.authServerUrl || !stored.clientId) {
    return undefined;
  }
  const metadata = await discoverOAuthMetadata(stored.authServerUrl);
  const token = await refreshAccessToken({
    metadata,
    client: {
      clientId: stored.clientId,
      redirectUri: "http://127.0.0.1/oauth/callback",
      scope: stored.scope
    },
    refreshToken: stored.refreshToken
  });
  const expiresAt = token.expires_in
    ? new Date(Date.now() + token.expires_in * 1000).toISOString()
    : undefined;
  input.store.upsertMcpOAuthToken({
    serverName: input.serverName,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? stored.refreshToken,
    tokenType: token.token_type,
    expiresAt,
    scope: token.scope ?? stored.scope,
    authServerUrl: stored.authServerUrl,
    clientId: stored.clientId
  });
  return token.access_token;
}

function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, platform() === "win32" ? ["", url] : [url], {
      detached: true,
      stdio: "ignore",
      shell: platform() === "win32"
    });
    child.unref();
  } catch {
    // Browser launch is best-effort; user can copy URL manually
  }
}
