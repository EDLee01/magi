import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig } = require("../src/config/load.js");

const tempDir = mkdtempSync(path.join(tmpdir(), "config-loader-fixture-"));

try {
  const validZeroConfig = path.join(tempDir, "valid-zero.json");
  writeFileSync(
    validZeroConfig,
    `${JSON.stringify(
      {
        server: { host: "127.0.0.1", port: 0 },
        client: { retryLimit: 0, timeoutMs: 1000 },
        features: { cache: false }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const loaded = loadConfig(validZeroConfig);
  assert.equal(loaded.server.port, 0);
  assert.equal(loaded.client.retryLimit, 0);
  assert.equal(loaded.features.cache, false);

  const invalidPortConfig = path.join(tempDir, "invalid-port.json");
  writeFileSync(
    invalidPortConfig,
    `${JSON.stringify({
      server: { host: "127.0.0.1", port: -1 },
      client: { retryLimit: 2, timeoutMs: 1000 }
    })}\n`,
    "utf8"
  );
  assert.throws(() => loadConfig(invalidPortConfig), /server\.port must be a number/);

  const invalidRetryConfig = path.join(tempDir, "invalid-retry.json");
  writeFileSync(
    invalidRetryConfig,
    `${JSON.stringify({
      server: { host: "127.0.0.1", port: 8080 },
      client: { retryLimit: 12, timeoutMs: 1000 }
    })}\n`,
    "utf8"
  );
  assert.throws(() => loadConfig(invalidRetryConfig), /client\.retryLimit must be a number/);

  console.log("config loader tests passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
