#!/usr/bin/env bash
set -euo pipefail

npm test

node - <<'NODE'
const { readFileSync } = require("node:fs");
const source = readFileSync("src/config/validate.js", "utf8");

if (!source.includes("config.server.port === undefined")) {
  throw new Error("server.port should only be required when undefined");
}
if (!source.includes("config.client.retryLimit === undefined")) {
  throw new Error("client.retryLimit should only be required when undefined");
}
if (source.includes("!config.server.port")) {
  throw new Error("falsy server.port check still rejects port 0");
}
if (source.includes("!config.client.retryLimit")) {
  throw new Error("falsy retryLimit check still rejects retryLimit 0");
}
NODE
