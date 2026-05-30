const projectConfig = {
  name: "boundary-demo",
  environment: "staging",
  api: {
    baseUrl: "https://api.example.test",
    timeoutMs: 2000
  },
  safety: {
    allowOutsideWorkspaceWrites: false
  }
};

module.exports = { projectConfig };
