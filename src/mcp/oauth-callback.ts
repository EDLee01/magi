/**
 * Temporary local HTTP server to receive the OAuth redirect.
 *
 * Listens on 127.0.0.1 on a random port, waits for `?code=...&state=...`,
 * shows a "you can close this tab now" page, then shuts down.
 */

import * as http from "node:http";
import { AddressInfo } from "node:net";
import { URL } from "node:url";

export interface CallbackResult {
  code: string;
  state: string;
}

export interface CallbackServerHandle {
  port: number;
  redirectUri: string;
  /** Resolves with the (code, state) pair when the redirect arrives. */
  result: Promise<CallbackResult>;
  close: () => void;
}

export function startOAuthCallbackServer(
  input: {
    /** Path component of the redirect URI. Default: /oauth/callback */
    path?: string;
    /** Maximum time to wait for the redirect, in ms. Default: 5 minutes */
    timeoutMs?: number;
  } = {}
): Promise<CallbackServerHandle> {
  const path = input.path ?? "/oauth/callback";
  const timeoutMs = input.timeoutMs ?? 5 * 60 * 1000;

  return new Promise((resolveHandle, rejectHandle) => {
    let resolveResult!: (value: CallbackResult) => void;
    let rejectResult!: (reason: Error) => void;
    const result = new Promise<CallbackResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== path) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          const errorDescription = url.searchParams.get("error_description") ?? "";
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.statusCode = 400;
          res.end(renderErrorPage(error, errorDescription));
          rejectResult(
            new Error(`OAuth authorization failed: ${error} ${errorDescription}`.trim())
          );
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(renderErrorPage("invalid_request", "Missing code or state"));
          rejectResult(new Error("OAuth callback missing code or state"));
          return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderSuccessPage());
        resolveResult({ code, state });
      } catch (error) {
        res.statusCode = 500;
        res.end("Internal server error");
        rejectResult(error instanceof Error ? error : new Error(String(error)));
      }
    });

    server.on("error", (error) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      rejectHandle(error);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      const redirectUri = `http://127.0.0.1:${port}${path}`;

      timeoutTimer = setTimeout(() => {
        rejectResult(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeoutTimer.unref?.();

      const close = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        server.close();
      };

      // Auto-close after result resolves or rejects
      result.finally(() => close()).catch(() => undefined);

      resolveHandle({ port, redirectUri, result, close });
    });
  });
}

function renderSuccessPage(): string {
  return `<!doctype html>
<html><head><title>Magi Next — Authorized</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:0 20px;color:#222;line-height:1.5}.ok{color:#0a8a3a}</style>
</head><body>
<h1 class="ok">✓ Authorization complete</h1>
<p>You may close this window and return to Magi Next.</p>
</body></html>`;
}

function renderErrorPage(error: string, description: string): string {
  return `<!doctype html>
<html><head><title>Magi Next — Authorization failed</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:0 20px;color:#222;line-height:1.5}.err{color:#c0282b}pre{background:#f4f4f4;padding:12px;border-radius:4px;white-space:pre-wrap}</style>
</head><body>
<h1 class="err">✗ Authorization failed</h1>
<pre>${escapeHtml(error)}\n${escapeHtml(description)}</pre>
<p>Return to Magi Next and try again.</p>
</body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[c] ?? c
  );
}
