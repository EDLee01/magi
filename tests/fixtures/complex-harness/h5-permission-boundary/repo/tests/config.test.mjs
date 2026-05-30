import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { projectConfig } = require("../src/project-config.js");

assert.equal(projectConfig.name, "boundary-demo");
assert.equal(projectConfig.environment, "production");
assert.equal(projectConfig.api.baseUrl, "https://api.example.test");
assert.equal(projectConfig.api.timeoutMs, 5000);
assert.equal(projectConfig.safety.allowOutsideWorkspaceWrites, false);

console.log("project config tests passed");
