/**
 * OAuth 2.0 Authorization Code flow with PKCE for MCP servers.
 *
 * MCP-spec OAuth: https://modelcontextprotocol.io/specification/draft/basic/authorization
 * The MCP server returns 401 with `WWW-Authenticate: Bearer realm="<auth-server-url>"`
 * pointing to an OAuth 2.0 Authorization Server. Discovery is via
 * `/.well-known/oauth-authorization-server`.
 */

import { createHash, randomBytes } from "node:crypto";

export interface OAuthMetadata {
  /** Authorization Server endpoint */
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  /** Optional Dynamic Client Registration endpoint (RFC 7591) */
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scope?: string;
}

export interface OAuthAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** Discover OAuth metadata from the Authorization Server. */
export async function discoverOAuthMetadata(authServerUrl: string): Promise<OAuthMetadata> {
  const base = authServerUrl.replace(/\/+$/, "");
  const candidates = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`
  ];
  for (const url of candidates) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const data = (await response.json()) as Partial<OAuthMetadata>;
      if (data.authorization_endpoint && data.token_endpoint) {
        return {
          issuer: data.issuer ?? base,
          authorization_endpoint: data.authorization_endpoint,
          token_endpoint: data.token_endpoint,
          registration_endpoint: data.registration_endpoint,
          scopes_supported: data.scopes_supported,
          response_types_supported: data.response_types_supported,
          grant_types_supported: data.grant_types_supported,
          code_challenge_methods_supported: data.code_challenge_methods_supported
        };
      }
    } catch {
      // Try next candidate
    }
  }
  throw new Error(`Could not discover OAuth metadata at ${authServerUrl}`);
}

/**
 * Dynamic Client Registration (RFC 7591) — register this client with the
 * Authorization Server when no static client_id is provided.
 */
export async function registerOAuthClient(input: {
  registrationEndpoint: string;
  redirectUri: string;
  clientName?: string;
  scope?: string;
}): Promise<{ clientId: string; clientSecret?: string }> {
  const body = {
    client_name: input.clientName ?? "Magi Next",
    redirect_uris: [input.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: input.scope ?? ""
  };
  const response = await fetch(input.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Dynamic Client Registration failed (${response.status}): ${text.slice(0, 200)}`
    );
  }
  const data = (await response.json()) as { client_id?: string; client_secret?: string };
  if (!data.client_id) {
    throw new Error("Dynamic Client Registration response missing client_id");
  }
  return { clientId: data.client_id, clientSecret: data.client_secret };
}

/**
 * Build an authorization URL with PKCE.
 * Caller must persist `state` and `codeVerifier` and pass them back when
 * exchanging the code for a token.
 */
export function buildAuthorizationRequest(input: {
  metadata: OAuthMetadata;
  client: OAuthClientConfig;
}): OAuthAuthorizationRequest {
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());
  const state = base64UrlEncode(randomBytes(16));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.client.clientId,
    redirect_uri: input.client.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });
  if (input.client.scope) {
    params.set("scope", input.client.scope);
  }
  const authorizationUrl = `${input.metadata.authorization_endpoint}?${params.toString()}`;
  return { authorizationUrl, state, codeVerifier };
}

/** Exchange the authorization code for an access token using PKCE. */
export async function exchangeCodeForToken(input: {
  metadata: OAuthMetadata;
  client: OAuthClientConfig;
  code: string;
  codeVerifier: string;
}): Promise<OAuthTokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.client.redirectUri,
    client_id: input.client.clientId,
    code_verifier: input.codeVerifier
  });
  if (input.client.clientSecret) {
    params.set("client_secret", input.client.clientSecret);
  }
  return performTokenRequest(input.metadata.token_endpoint, params);
}

/** Refresh an access token using the refresh_token. */
export async function refreshAccessToken(input: {
  metadata: OAuthMetadata;
  client: OAuthClientConfig;
  refreshToken: string;
}): Promise<OAuthTokenResponse> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.client.clientId
  });
  if (input.client.clientSecret) {
    params.set("client_secret", input.client.clientSecret);
  }
  return performTokenRequest(input.metadata.token_endpoint, params);
}

/**
 * Parse the WWW-Authenticate header from an MCP server 401 response.
 * Returns the auth server URL ("realm" or "authorization_uri" parameter).
 */
export function parseWwwAuthenticate(header: string | null): { authServerUrl: string } | undefined {
  if (!header) return undefined;
  // e.g. Bearer realm="https://auth.example.com", scope="mcp.read"
  const bearer = /^\s*Bearer\b/i.test(header);
  if (!bearer) return undefined;
  const match = /(?:realm|resource|authorization_uri|as_uri)="([^"]+)"/i.exec(header);
  if (!match) return undefined;
  try {
    new URL(match[1]);
    return { authServerUrl: match[1] };
  } catch {
    return undefined;
  }
}

async function performTokenRequest(
  endpoint: string,
  params: URLSearchParams
): Promise<OAuthTokenResponse> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: params.toString()
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token endpoint returned ${response.status}: ${text.slice(0, 200)}`);
  }
  let data: OAuthTokenResponse;
  try {
    data = JSON.parse(text) as OAuthTokenResponse;
  } catch {
    throw new Error(`Token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!data.access_token) {
    throw new Error("Token endpoint response missing access_token");
  }
  return data;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
