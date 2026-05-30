import { SlashCommandInput } from "./registry.js";
import { McpConnectionManager } from "../mcp/connection-manager.js";
import { runOAuthFlow } from "../mcp/oauth-flow.js";

export const command = {
  name: "mcp",
  description: "List, connect, or inspect configured MCP servers",
  usage:
    "/mcp [list|tools <server>|resources <server>|prompts <server>|connect <server>|disconnect <server>|health <server>|health-all|auth <server>|logout <server>|tokens]",
  group: "Extensions",
  handler: async (args: string[], input: SlashCommandInput): Promise<string> => {
    const servers = input.config.mcp?.servers ?? {};
    const serverNames = Object.keys(servers);

    if (serverNames.length === 0) {
      return [
        "No MCP servers configured.",
        "",
        "Configure MCP servers in ~/.magi-next/config.yaml:",
        "",
        "  mcp:",
        "    servers:",
        "      linear:",
        "        command: npx",
        '        args: ["-y", "@modelcontextprotocol/server-linear"]',
        "        env:",
        '          LINEAR_API_KEY: "..."',
        "",
        "Or for HTTP/SSE servers:",
        "  mcp:",
        "    servers:",
        "      remote:",
        "        url: https://example.com/mcp",
        "        headers:",
        '          Authorization: "Bearer ..."'
      ].join("\n");
    }

    const sub = args[0] ?? "list";

    if (sub === "list" || args.length === 0) {
      const lines = ["Configured MCP servers:"];
      for (const name of serverNames) {
        const server = servers[name];
        const transport = server.transport ?? (server.url ? "http" : "stdio");
        const detail = server.url
          ? `${transport}: ${server.url}`
          : `${transport}: ${server.command}`;
        lines.push(`  ${name.padEnd(20)} ${detail}`);
      }
      lines.push("");
      lines.push("Use /mcp tools <server> or /mcp resources <server> to inspect.");
      lines.push("Use /mcp health <server> to test the connection.");
      return lines.join("\n");
    }

    if (sub === "tokens") {
      const tokens = input.store.listMcpOAuthTokens();
      if (tokens.length === 0) {
        return "No stored OAuth tokens. Use /mcp auth <server> to authorize a server.";
      }
      const lines = ["Stored OAuth tokens:", ""];
      for (const t of tokens) {
        const expires = t.expiresAt
          ? `expires ${new Date(t.expiresAt).toISOString().slice(0, 19)}`
          : "no expiry";
        const refresh = t.refreshToken ? "refresh ✓" : "refresh ✗";
        lines.push(`  ${t.serverName.padEnd(20)} ${refresh.padEnd(12)} ${expires}`);
      }
      return lines.join("\n");
    }

    if (sub === "logout") {
      const serverName = args[1];
      if (!serverName) return "Usage: /mcp logout <server>";
      const stored = input.store.getMcpOAuthToken(serverName);
      if (!stored) return `No stored token for ${serverName}`;
      input.store.deleteMcpOAuthToken(serverName);
      return `Removed stored token for ${serverName}`;
    }

    if (sub === "auth") {
      const serverName = args[1];
      if (!serverName) return "Usage: /mcp auth <server>";
      if (!servers[serverName]) {
        return `Server not configured: ${serverName}. Available: ${serverNames.join(", ")}`;
      }
      const oauthCfg = servers[serverName].oauth;
      const authServerUrl = oauthCfg?.authServerUrl;
      if (!authServerUrl) {
        return [
          `Server ${serverName} has no oauth.authServerUrl configured.`,
          "",
          "Add to ~/.magi-next/config.yaml:",
          "  mcp:",
          "    servers:",
          `      ${serverName}:`,
          "        url: https://...",
          "        oauth:",
          "          authServerUrl: https://auth.example.com",
          '          scope: "mcp.read mcp.write"',
          "          # clientId: optional, falls back to Dynamic Client Registration"
        ].join("\n");
      }
      try {
        const result = await runOAuthFlow({
          serverName,
          authServerUrl,
          store: input.store,
          scope: oauthCfg?.scope,
          clientId: oauthCfg?.clientId,
          clientSecret: oauthCfg?.clientSecret,
          onAuthorizationUrl: (url) => {
            // Note: this is async, the user already sees prompt return below
            console.log(
              `\nOpen this URL in your browser if it doesn't open automatically:\n${url}\n`
            );
          }
        });
        const expires = result.expiresAt
          ? `expires ${new Date(result.expiresAt).toISOString().slice(0, 19)}`
          : "no expiry";
        return [
          `✓ Authorized ${serverName}`,
          `  Token type: Bearer`,
          `  Scope: ${result.scope ?? "(none)"}`,
          `  ${expires}`,
          `  Refresh token: ${result.refreshToken ? "stored" : "not provided"}`
        ].join("\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `✗ OAuth failed for ${serverName}: ${msg}`;
      }
    }

    if (sub === "health-all") {
      const manager = new McpConnectionManager({ servers, env: input.env });
      try {
        const lines = ["Health check across all servers:", ""];
        for (const name of serverNames) {
          try {
            const client = await manager.connect(name);
            const healthy = await client.ping(3000);
            lines.push(`  ${name.padEnd(20)} ${healthy ? "OK" : "UNHEALTHY"}`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            lines.push(`  ${name.padEnd(20)} FAILED (${msg.slice(0, 60)})`);
          }
        }
        return lines.join("\n");
      } finally {
        manager.disconnectAll();
      }
    }

    if (
      sub === "tools" ||
      sub === "resources" ||
      sub === "prompts" ||
      sub === "health" ||
      sub === "connect" ||
      sub === "disconnect"
    ) {
      const serverName = args[1];
      if (!serverName) return `Usage: /mcp ${sub} <server>`;
      if (!servers[serverName]) {
        return `Server not configured: ${serverName}. Available: ${serverNames.join(", ")}`;
      }
      const manager = new McpConnectionManager({ servers, env: input.env });
      try {
        if (sub === "disconnect") {
          manager.disconnect(serverName);
          return `Disconnected from ${serverName}`;
        }
        const client = await manager.connect(serverName);
        if (sub === "connect") {
          const transport =
            servers[serverName].transport ?? (servers[serverName].url ? "http" : "stdio");
          return `Connected to ${serverName} (transport: ${transport})`;
        }
        if (sub === "health") {
          const transport =
            servers[serverName].transport ?? (servers[serverName].url ? "http" : "stdio");
          const ok = await client.ping(3000);
          return ok
            ? `${serverName}: OK (transport: ${transport})`
            : `${serverName}: UNHEALTHY (no response within 3s)`;
        }
        if (sub === "tools") {
          const tools = await client.listTools();
          if (tools.length === 0) return `${serverName}: no tools advertised`;
          const lines = [`${serverName}: ${tools.length} tools`, ""];
          for (const t of tools) {
            lines.push(`  ${t.name.padEnd(30)} ${t.description ?? ""}`);
          }
          return lines.join("\n");
        }
        if (sub === "resources") {
          const resources = await client.listResources();
          if (resources.length === 0) return `${serverName}: no resources advertised`;
          const lines = [`${serverName}: ${resources.length} resources`, ""];
          for (const r of resources) {
            const meta = [r.mimeType, r.name].filter(Boolean).join(" · ");
            lines.push(`  ${r.uri.padEnd(40)} ${meta}`);
          }
          return lines.join("\n");
        }
        if (sub === "prompts") {
          const prompts = await client.listPrompts();
          if (prompts.length === 0) return `${serverName}: no prompts advertised`;
          const lines = [`${serverName}: ${prompts.length} prompts`, ""];
          for (const p of prompts) {
            const argList =
              p.arguments && p.arguments.length > 0
                ? ` (args: ${p.arguments.map((a) => (a.required ? a.name : `${a.name}?`)).join(", ")})`
                : "";
            lines.push(`  ${p.name.padEnd(30)} ${p.description ?? ""}${argList}`);
          }
          return lines.join("\n");
        }
        return `Unknown subcommand: ${sub}`;
      } catch (error) {
        return `Failed to ${sub} ${serverName}: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        // Always close on one-off command (the agent loop has its own connection)
        if (sub !== "connect") {
          manager.disconnectAll();
        }
      }
    }

    return `Unknown subcommand: ${sub}. Usage: ${command.usage}`;
  }
};
