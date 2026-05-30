function validateConfig(config) {
  const errors = [];

  if (!config.server) {
    errors.push("server section is required");
  } else {
    if (!config.server.host) {
      errors.push("server.host is required");
    }
    if (!config.server.port) {
      errors.push("server.port is required");
    }
    if (
      typeof config.server.port !== "number" ||
      config.server.port < 0 ||
      config.server.port > 65535
    ) {
      errors.push("server.port must be a number between 0 and 65535");
    }
  }

  if (!config.client) {
    errors.push("client section is required");
  } else {
    if (!config.client.retryLimit) {
      errors.push("client.retryLimit is required");
    }
    if (
      typeof config.client.retryLimit !== "number" ||
      config.client.retryLimit < 0 ||
      config.client.retryLimit > 10
    ) {
      errors.push("client.retryLimit must be a number between 0 and 10");
    }
    if (typeof config.client.timeoutMs !== "number" || config.client.timeoutMs <= 0) {
      errors.push("client.timeoutMs must be a positive number");
    }
  }

  return errors;
}

module.exports = { validateConfig };
