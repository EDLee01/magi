import { describe, it, expect } from "vitest";
import {
  buildAuthorizationRequest,
  parseWwwAuthenticate,
  type OAuthMetadata
} from "../src/mcp/oauth.js";

describe("OAuth 2.0 client", () => {
  describe("parseWwwAuthenticate", () => {
    it("parses realm parameter", () => {
      const result = parseWwwAuthenticate('Bearer realm="https://auth.example.com"');
      expect(result?.authServerUrl).toBe("https://auth.example.com");
    });

    it("parses authorization_uri parameter", () => {
      const result = parseWwwAuthenticate(
        'Bearer authorization_uri="https://auth.example.com/oauth"'
      );
      expect(result?.authServerUrl).toBe("https://auth.example.com/oauth");
    });

    it("parses as_uri parameter (MCP-spec compatible)", () => {
      const result = parseWwwAuthenticate(
        'Bearer as_uri="https://auth.linear.app", scope="mcp.read"'
      );
      expect(result?.authServerUrl).toBe("https://auth.linear.app");
    });

    it("returns undefined for non-Bearer schemes", () => {
      expect(parseWwwAuthenticate('Basic realm="example"')).toBeUndefined();
    });

    it("returns undefined for malformed URLs", () => {
      expect(parseWwwAuthenticate('Bearer realm="not-a-url"')).toBeUndefined();
    });

    it("returns undefined for null/empty input", () => {
      expect(parseWwwAuthenticate(null)).toBeUndefined();
      expect(parseWwwAuthenticate("")).toBeUndefined();
    });
  });

  describe("buildAuthorizationRequest (PKCE)", () => {
    const metadata: OAuthMetadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token"
    };

    it("builds an authorization URL with required PKCE parameters", () => {
      const req = buildAuthorizationRequest({
        metadata,
        client: {
          clientId: "abc",
          redirectUri: "http://127.0.0.1:8080/oauth/callback",
          scope: "read write"
        }
      });
      const url = new URL(req.authorizationUrl);
      expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe("abc");
      expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8080/oauth/callback");
      expect(url.searchParams.get("scope")).toBe("read write");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("state")).toBeTruthy();
    });

    it("returns code verifier and state for round-tripping", () => {
      const req = buildAuthorizationRequest({
        metadata,
        client: {
          clientId: "abc",
          redirectUri: "http://127.0.0.1:8080/cb"
        }
      });
      expect(req.codeVerifier).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(req.state).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("generates a different verifier and state each call", () => {
      const a = buildAuthorizationRequest({
        metadata,
        client: { clientId: "abc", redirectUri: "http://127.0.0.1:8080/cb" }
      });
      const b = buildAuthorizationRequest({
        metadata,
        client: { clientId: "abc", redirectUri: "http://127.0.0.1:8080/cb" }
      });
      expect(a.codeVerifier).not.toBe(b.codeVerifier);
      expect(a.state).not.toBe(b.state);
    });

    it("omits scope from URL when not provided", () => {
      const req = buildAuthorizationRequest({
        metadata,
        client: { clientId: "abc", redirectUri: "http://127.0.0.1:8080/cb" }
      });
      const url = new URL(req.authorizationUrl);
      expect(url.searchParams.get("scope")).toBeNull();
    });
  });
});
