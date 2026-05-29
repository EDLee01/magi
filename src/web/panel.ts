import { VERSION } from "../version.js";

// Re-export the mobile-friendly panel as the primary renderer.
export { renderWebPanel } from "./panel-html.js";

export function renderClassicWebPanel(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Magi Next Panel</title>
  <style>
    body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: #f7f7f8; color: #18181b; }
    header { background: #18181b; color: white; padding: 14px 20px; }
    main { max-width: 1120px; margin: 0 auto; padding: 18px; display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    section { background: white; border: 1px solid #d4d4d8; border-radius: 8px; padding: 14px; min-height: 140px; }
    h1 { font-size: 18px; margin: 0; }
    h2 { font-size: 14px; margin: 0 0 10px; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-size: 12px; }
  </style>
</head>
<body>
  <header><h1>Magi Next Panel</h1></header>
  <main>
    <section><h2>Sessions</h2><pre id="sessions">loading</pre></section>
    <section><h2>Jobs</h2><pre id="jobs">loading</pre></section>
    <section><h2>Events</h2><pre id="events">loading</pre></section>
    <section><h2>Providers</h2><pre id="providers">loading</pre></section>
  </main>
  <script type="module">
    import { createMagiPanelClient } from "/panel-client.js";
    const client = createMagiPanelClient();
    const render = (id, value) => document.getElementById(id).textContent = JSON.stringify(value, null, 2);
    const fail = (id, error) => document.getElementById(id).textContent = String(error.message || error);
    client.sessions().then((value) => render("sessions", value)).catch((error) => fail("sessions", error));
    client.jobs().then((value) => render("jobs", value)).catch((error) => fail("jobs", error));
    client.events().then((value) => render("events", value.events || value)).catch((error) => fail("events", error));
    client.providers().then((value) => render("providers", value)).catch((error) => fail("providers", error));
  </script>
</body>
</html>
`;
}

export function renderPanelClient(): string {
  return `export function createMagiPanelClient(baseUrl = "") {
  async function get(path) {
    const headers = {};
    const deviceId = window.localStorage.getItem("MAGI_DEVICE_ID");
    const token = window.localStorage.getItem("MAGI_DEVICE_TOKEN");
    if (deviceId && token) {
      headers["x-magi-device-id"] = deviceId;
      headers.authorization = "Bearer " + token;
    }
    const response = await fetch(baseUrl + path, { headers });
    if (!response.ok) throw new Error(path + " failed: " + response.status);
    return response.json();
  }
  async function post(path, body = {}) {
    const headers = { "content-type": "application/json" };
    const deviceId = window.localStorage.getItem("MAGI_DEVICE_ID");
    const token = window.localStorage.getItem("MAGI_DEVICE_TOKEN");
    if (deviceId && token) {
      headers["x-magi-device-id"] = deviceId;
      headers.authorization = "Bearer " + token;
    }
    const response = await fetch(baseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(path + " failed: " + response.status);
    return response.json();
  }
  return {
    sessions: () => get("/sessions"),
    session: (id) => get("/sessions/" + encodeURIComponent(id)),
    createSession: async (body) => {
      const result = await post("/sessions", body);
      return result.session || result;
    },
    sendMessage: (id, body) => post("/sessions/" + encodeURIComponent(id) + "/messages", body),
    startJob: (body) => post("/jobs", body),
    jobs: () => get("/jobs"),
    job: (id) => get("/jobs/" + encodeURIComponent(id)),
    cancelJob: (id, reason) => post("/jobs/" + encodeURIComponent(id) + "/cancel", { reason }),
    jobInteractions: (id) => get("/jobs/" + encodeURIComponent(id) + "/interactions"),
    resolveApproval: (jobId, toolUseId, decision, body = {}) =>
      post("/jobs/" + encodeURIComponent(jobId) + "/approvals/" + encodeURIComponent(toolUseId), {
        ...body,
        decision
      }),
    cancelApproval: (jobId, toolUseId, reason) =>
      post(
        "/jobs/" + encodeURIComponent(jobId) + "/approvals/" + encodeURIComponent(toolUseId) + "/cancel",
        { reason }
      ),
    answerQuestion: (jobId, toolUseId, body) =>
      post("/jobs/" + encodeURIComponent(jobId) + "/questions/" + encodeURIComponent(toolUseId), body),
    cancelQuestion: (jobId, toolUseId, reason) =>
      post(
        "/jobs/" + encodeURIComponent(jobId) + "/questions/" + encodeURIComponent(toolUseId) + "/cancel",
        { reason }
      ),
    events: () => get("/events.json"),
    sessionEvents: (id) => get("/sessions/" + encodeURIComponent(id) + "/events"),
    jobEvents: (id) => get("/jobs/" + encodeURIComponent(id) + "/events"),
    audit: () => get("/audit"),
    providers: () => get("/providers"),
    plugins: () => get("/plugins"),
    skills: () => get("/skills")
  };
}
`;
}

export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Magi Next Control API", version: VERSION },
    paths: {
      "/health": { get: { summary: "Health check" } },
      "/sessions": { get: { summary: "List sessions" }, post: { summary: "Create session" } },
      "/sessions/{id}": { get: { summary: "Get session transcript" } },
      "/sessions/{id}/events": { get: { summary: "List session events" } },
      "/sessions/{id}/messages": { post: { summary: "Submit prompt to session" } },
      "/jobs": { get: { summary: "List jobs" }, post: { summary: "Create job" } },
      "/jobs/{id}": { get: { summary: "Get job status" } },
      "/jobs/{id}/cancel": { post: { summary: "Cancel running job" } },
      "/jobs/{id}/events": { get: { summary: "List job events" } },
      "/jobs/{id}/interactions": { get: { summary: "List active job interactions" } },
      "/jobs/{id}/approvals/{toolUseId}": { post: { summary: "Resolve active approval" } },
      "/jobs/{id}/approvals/{toolUseId}/cancel": { post: { summary: "Cancel active approval" } },
      "/jobs/{id}/questions/{toolUseId}": { post: { summary: "Resolve active user question" } },
      "/jobs/{id}/questions/{toolUseId}/cancel": {
        post: { summary: "Cancel active user question" }
      },
      "/events": { get: { summary: "Stream recent events as SSE" } },
      "/events.json": { get: { summary: "List recent events" } },
      "/approvals": { post: { summary: "Record approval" } },
      "/providers": { get: { summary: "Provider status" } },
      "/plugins": { get: { summary: "List plugins" } },
      "/skills": { get: { summary: "List skills" } },
      "/audit": { get: { summary: "List audit events" } }
    }
  };
}
