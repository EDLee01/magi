const { readFileSync } = require("node:fs");
const { mergeConfig } = require("./defaults");
const { validateConfig } = require("./validate");

function loadConfig(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const config = mergeConfig(parsed);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid config:\n${errors.join("\n")}`);
  }
  return config;
}

module.exports = { loadConfig };
