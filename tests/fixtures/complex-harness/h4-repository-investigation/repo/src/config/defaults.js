const DEFAULT_CONFIG = {
  server: {
    host: "127.0.0.1",
    port: 3000
  },
  client: {
    retryLimit: 3,
    timeoutMs: 5000
  },
  features: {
    cache: true
  }
};

function mergeConfig(input) {
  return {
    server: {
      host: input.server?.host ?? DEFAULT_CONFIG.server.host,
      port: input.server?.port ?? DEFAULT_CONFIG.server.port
    },
    client: {
      retryLimit: input.client?.retryLimit ?? DEFAULT_CONFIG.client.retryLimit,
      timeoutMs: input.client?.timeoutMs ?? DEFAULT_CONFIG.client.timeoutMs
    },
    features: {
      cache: input.features?.cache ?? DEFAULT_CONFIG.features.cache
    }
  };
}

module.exports = { DEFAULT_CONFIG, mergeConfig };
