export function renderWebPanel(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#0a0a0a">
  <title>Magi Next</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --panel: #18181b;
      --panel-2: #27272a;
      --border: #3f3f46;
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --accent: #22d3ee;
      --accent-dim: #0e7490;
      --user-bg: #1e3a8a;
      --error: #ef4444;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      overscroll-behavior: contain;
    }
    body {
      display: flex;
      flex-direction: column;
      height: 100vh;
      height: 100dvh;
    }
    header {
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    header h1 {
      font-size: 15px;
      font-weight: 600;
      margin: 0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    header .indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-dim);
    }
    header .indicator.online { background: #10b981; }
    header .indicator.offline { background: var(--error); }
    header button {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    header button:active { background: var(--panel-2); }
    main {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      -webkit-overflow-scrolling: touch;
    }
    .messages {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 800px;
      margin: 0 auto;
    }
    .msg {
      padding: 10px 12px;
      border-radius: 12px;
      max-width: 88%;
      word-wrap: break-word;
      white-space: pre-wrap;
      font-size: 14px;
    }
    .msg.user {
      background: var(--user-bg);
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }
    .msg.assistant {
      background: var(--panel-2);
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .msg.system {
      background: transparent;
      color: var(--text-dim);
      align-self: center;
      font-size: 12px;
      text-align: center;
    }
    .msg.error {
      background: rgba(239, 68, 68, 0.15);
      color: var(--error);
      align-self: stretch;
      font-size: 13px;
      border: 1px solid rgba(239, 68, 68, 0.4);
    }
    .msg .meta {
      font-size: 11px;
      color: var(--text-dim);
      margin-top: 4px;
    }
    .tool-call {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      align-self: flex-start;
      max-width: 88%;
      color: var(--text-dim);
    }
    .tool-call .name { color: var(--accent); font-weight: 600; }
    .interaction-card {
      background: var(--panel);
      border: 1px solid var(--accent-dim);
      border-radius: 8px;
      padding: 10px 12px;
      align-self: stretch;
      font-size: 13px;
    }
    .interaction-card .title { font-weight: 600; margin-bottom: 4px; }
    .interaction-card .detail { color: var(--text-dim); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .interaction-card .actions { display: flex; gap: 8px; margin-top: 10px; }
    .interaction-card button {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 7px 10px;
      background: var(--panel-2);
      color: var(--text);
      cursor: pointer;
    }
    .interaction-card button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .interaction-card button.danger { border-color: rgba(239, 68, 68, 0.7); color: #fecaca; }
    .interaction-card.resolved { border-color: var(--border); opacity: 0.75; }
    footer {
      flex-shrink: 0;
      background: var(--panel);
      border-top: 1px solid var(--border);
      padding: 10px 12px;
      padding-bottom: max(10px, env(safe-area-inset-bottom));
    }
    .input-row {
      max-width: 800px;
      margin: 0 auto;
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    textarea {
      flex: 1;
      background: var(--panel-2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      font: inherit;
      resize: none;
      max-height: 140px;
      min-height: 42px;
      -webkit-tap-highlight-color: transparent;
    }
    textarea:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
    .send-btn {
      background: var(--accent);
      color: var(--bg);
      border: none;
      border-radius: 12px;
      padding: 0 16px;
      height: 42px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
    }
    .send-btn:disabled { background: var(--panel-2); color: var(--text-dim); cursor: not-allowed; }
    .send-btn:active:not(:disabled) { background: var(--accent-dim); }
    .drawer-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 9;
      display: none;
    }
    .drawer-overlay.open { display: block; }
    .drawer {
      position: fixed;
      top: 0;
      right: 0;
      width: min(360px, 90vw);
      height: 100vh;
      height: 100dvh;
      background: var(--panel);
      border-left: 1px solid var(--border);
      transform: translateX(100%);
      transition: transform 0.2s ease;
      z-index: 10;
      overflow-y: auto;
      padding: 16px;
    }
    .drawer.open { transform: translateX(0); }
    .drawer h2 { margin: 0 0 12px; font-size: 14px; }
    .drawer .close-btn {
      float: right;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
    }
    .drawer label { display: block; font-size: 12px; color: var(--text-dim); margin: 12px 0 4px; }
    .drawer input, .drawer select {
      width: 100%;
      background: var(--panel-2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
    }
    .drawer .session-item {
      padding: 10px;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid transparent;
      margin-bottom: 6px;
    }
    .drawer .session-item:hover, .drawer .session-item.active { background: var(--panel-2); border-color: var(--border); }
    .drawer .session-item .title { font-size: 13px; font-weight: 500; }
    .drawer .session-item .time { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
    .typing { color: var(--text-dim); font-style: italic; }
    .empty { color: var(--text-dim); text-align: center; margin-top: 40px; }
  </style>
</head>
<body>
  <header>
    <span class="indicator" id="status-indicator"></span>
    <h1 id="header-title">Magi Next</h1>
    <button id="new-btn">New</button>
    <button id="menu-btn">☰</button>
  </header>
  <main id="main">
    <div class="messages" id="messages">
      <div class="empty">Send a message to start a conversation.</div>
    </div>
  </main>
  <footer>
    <div class="input-row">
      <textarea id="input" placeholder="Send a message…" rows="1" autocomplete="off"></textarea>
      <button class="send-btn" id="send-btn">Send</button>
    </div>
  </footer>
  <div class="drawer-overlay" id="overlay"></div>
  <aside class="drawer" id="drawer">
    <button class="close-btn" id="close-drawer">Close</button>
    <h2>Sessions</h2>
    <div id="session-list"></div>

    <h2 style="margin-top: 24px">Settings</h2>
    <label for="model-select">Model</label>
    <select id="model-select">
      <option value="auto">auto (smart routing)</option>
      <option value="main">main</option>
      <option value="fast">fast</option>
      <option value="review">review</option>
      <option value="deep">deep</option>
    </select>

    <label for="device-id-input">Device ID</label>
    <input id="device-id-input" type="text" placeholder="(empty if loopback)">
    <label for="token-input">Token</label>
    <input id="token-input" type="password" placeholder="(empty if loopback)">

    <h2 style="margin-top: 24px">About</h2>
    <div style="font-size: 12px; color: var(--text-dim); line-height: 1.6;">
      <div id="endpoint-info"></div>
      <div id="provider-info"></div>
    </div>
  </aside>
  <script type="module">
    import { createMagiPanelClient } from "/panel-client.js";

    // Allow ?token=...&device=... in URL (for QR-pair handoff)
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.get("device") && urlParams.get("token")) {
      localStorage.setItem("MAGI_DEVICE_ID", urlParams.get("device"));
      localStorage.setItem("MAGI_DEVICE_TOKEN", urlParams.get("token"));
      // Clean URL so token isn't visible/bookmarked
      history.replaceState({}, "", location.pathname);
    }

    const client = createMagiPanelClient();
    const els = {
      messages: document.getElementById("messages"),
      input: document.getElementById("input"),
      sendBtn: document.getElementById("send-btn"),
      newBtn: document.getElementById("new-btn"),
      menuBtn: document.getElementById("menu-btn"),
      drawer: document.getElementById("drawer"),
      overlay: document.getElementById("overlay"),
      closeDrawer: document.getElementById("close-drawer"),
      sessionList: document.getElementById("session-list"),
      modelSelect: document.getElementById("model-select"),
      deviceIdInput: document.getElementById("device-id-input"),
      tokenInput: document.getElementById("token-input"),
      indicator: document.getElementById("status-indicator"),
      title: document.getElementById("header-title"),
      endpointInfo: document.getElementById("endpoint-info"),
      providerInfo: document.getElementById("provider-info"),
      main: document.getElementById("main")
    };

    let currentSessionId = null;
    let currentJobEventSource = null;
    let isStreaming = false;
    let activeJobId = null;

    // Restore settings
    els.modelSelect.value = localStorage.getItem("MAGI_MODEL") || "auto";
    els.deviceIdInput.value = localStorage.getItem("MAGI_DEVICE_ID") || "";
    els.tokenInput.value = localStorage.getItem("MAGI_DEVICE_TOKEN") || "";
    els.modelSelect.addEventListener("change", () => localStorage.setItem("MAGI_MODEL", els.modelSelect.value));
    els.deviceIdInput.addEventListener("change", () => localStorage.setItem("MAGI_DEVICE_ID", els.deviceIdInput.value));
    els.tokenInput.addEventListener("change", () => localStorage.setItem("MAGI_DEVICE_TOKEN", els.tokenInput.value));

    // Auto-resize textarea
    els.input.addEventListener("input", () => {
      els.input.style.height = "auto";
      els.input.style.height = Math.min(140, els.input.scrollHeight) + "px";
    });
    // Enter to send (Shift+Enter for newline)
    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        send();
      }
    });
    els.sendBtn.addEventListener("click", () => {
      if (isStreaming) cancelActiveJob();
      else send();
    });
    els.newBtn.addEventListener("click", newSession);
    els.menuBtn.addEventListener("click", openDrawer);
    els.closeDrawer.addEventListener("click", closeDrawer);
    els.overlay.addEventListener("click", closeDrawer);

    function openDrawer() {
      els.drawer.classList.add("open");
      els.overlay.classList.add("open");
      loadSessions();
    }
    function closeDrawer() {
      els.drawer.classList.remove("open");
      els.overlay.classList.remove("open");
    }
    function newSession() {
      currentSessionId = null;
      els.title.textContent = "New conversation";
      els.messages.innerHTML = '<div class="empty">Send a message to start a conversation.</div>';
      closeDrawer();
    }

    function addMessage(role, text, opts) {
      const empty = els.messages.querySelector(".empty");
      if (empty) empty.remove();
      const div = document.createElement("div");
      div.className = "msg " + role;
      if (opts && opts.id) div.id = opts.id;
      div.textContent = text;
      els.messages.appendChild(div);
      els.main.scrollTop = els.main.scrollHeight;
      return div;
    }

    function addToolCall(name) {
      const empty = els.messages.querySelector(".empty");
      if (empty) empty.remove();
      const div = document.createElement("div");
      div.className = "tool-call";
      div.innerHTML = '<span class="name">' + escapeHtml(name) + '</span> running…';
      els.messages.appendChild(div);
      els.main.scrollTop = els.main.scrollHeight;
      return div;
    }

    function addApprovalCard(jobId, evt) {
      const empty = els.messages.querySelector(".empty");
      if (empty) empty.remove();
      const toolUseId = evt.metadata && evt.metadata.toolUseId;
      const card = document.createElement("div");
      card.className = "interaction-card";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = "Approval needed: " + (evt.target || "tool");
      const detail = document.createElement("div");
      detail.className = "detail";
      detail.textContent = (evt.metadata && (evt.metadata.reason || evt.metadata.diff)) || evt.message || "";
      const actions = document.createElement("div");
      actions.className = "actions";
      const approve = document.createElement("button");
      approve.className = "primary";
      approve.textContent = "Approve";
      const deny = document.createElement("button");
      deny.className = "danger";
      deny.textContent = "Deny";
      approve.addEventListener("click", () => resolveApprovalCard(card, jobId, toolUseId, "approve"));
      deny.addEventListener("click", () => resolveApprovalCard(card, jobId, toolUseId, "deny"));
      actions.append(approve, deny);
      card.append(title, detail, actions);
      els.messages.appendChild(card);
      els.main.scrollTop = els.main.scrollHeight;
    }

    async function resolveApprovalCard(card, jobId, toolUseId, decision) {
      if (!toolUseId) return;
      const buttons = card.querySelectorAll("button");
      buttons.forEach((button) => button.disabled = true);
      try {
        await client.resolveApproval(jobId, toolUseId, decision, { responder: "panel" });
        card.classList.add("resolved");
        card.querySelector(".detail").textContent = decision === "approve" ? "Approved from panel." : "Denied from panel.";
      } catch (error) {
        buttons.forEach((button) => button.disabled = false);
        addMessage("error", "Approval failed: " + (error.message || error));
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"})[c] || c);
    }

    async function cancelActiveJob() {
      if (!activeJobId) return;
      els.sendBtn.disabled = true;
      try {
        await client.cancelJob(activeJobId, "cancelled from panel");
        addMessage("system", "Cancelling…");
      } catch (error) {
        addMessage("error", "Cancel failed: " + (error.message || error));
      } finally {
        els.sendBtn.disabled = false;
      }
    }

    async function send() {
      if (isStreaming) return;
      const text = els.input.value.trim();
      if (!text) return;
      els.input.value = "";
      els.input.style.height = "auto";
      els.input.disabled = true;
      els.sendBtn.disabled = false;
      els.sendBtn.textContent = "Stop";
      isStreaming = true;
      addMessage("user", text);

      try {
        if (!currentSessionId) {
          const session = await client.createSession({ title: text.slice(0, 60), metadata: { source: "panel" } });
          currentSessionId = session.id;
          els.title.textContent = text.slice(0, 60);
        }
        const modelAlias = els.modelSelect.value;
        const result = await client.startJob({
          content: text,
          modelAlias,
          sessionId: currentSessionId,
          background: true,
          metadata: { source: "panel" }
        });
        if (result.sessionId) {
          currentSessionId = result.sessionId;
        }
        activeJobId = result.jobId;
        const assistantDiv = addMessage("assistant", "");
        await streamJobEvents(result.jobId, assistantDiv);
      } catch (error) {
        addMessage("error", "Error: " + (error.message || error));
      } finally {
        activeJobId = null;
        els.input.disabled = false;
        els.sendBtn.disabled = false;
        els.sendBtn.textContent = "Send";
        isStreaming = false;
        els.input.focus();
      }
    }

    async function streamJobEvents(jobId, assistantDiv) {
      if (!jobId) throw new Error("No job id returned from Control API");
      const headers = {};
      const deviceId = localStorage.getItem("MAGI_DEVICE_ID");
      const token = localStorage.getItem("MAGI_DEVICE_TOKEN");
      if (deviceId && token) {
        headers["x-magi-device-id"] = deviceId;
        headers.authorization = "Bearer " + token;
      }
      const response = await fetch("/events?jobId=" + encodeURIComponent(jobId) + "&limit=50", { headers });
      if (!response.ok) throw new Error("Stream failed: " + response.status);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      let status = "running";
      const seenInteractions = new Set();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf("\\n\\n");
        while (sep >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of block.split("\\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const evt = JSON.parse(line.slice(5).trim());
              if (evt.action === "agent.text.delta" && evt.metadata && evt.metadata.preview) {
                assistantText += evt.metadata.preview;
                assistantDiv.textContent = assistantText;
                els.main.scrollTop = els.main.scrollHeight;
              } else if (evt.action === "agent.tool.use" && evt.target) {
                addToolCall(evt.target);
              } else if (evt.action === "agent.approval.pending") {
                const key = evt.metadata?.toolUseId || evt.id;
                if (!seenInteractions.has(key)) {
                  seenInteractions.add(key);
                  addApprovalCard(jobId, evt);
                }
              } else if (evt.action === "agent.user_question.pending") {
                addMessage("system", "Question pending: " + (evt.message || evt.target || "user input"));
              } else if (evt.action === "agent.query.completed") {
                status = "completed";
                if (!assistantText && evt.message) assistantDiv.textContent = evt.message;
              } else if (evt.action === "agent.query.failed") {
                status = "failed";
                addMessage("error", "Error: " + (evt.metadata?.error || evt.message || "query failed"));
              } else if (evt.action === "agent.query.cancelled") {
                status = "cancelled";
                addMessage("system", "Cancelled");
              } else if (evt.action === "agent.query.done") {
                if (!assistantText && evt.message) assistantDiv.textContent = evt.message;
              }
            } catch {}
          }
          if (status === "completed" || status === "failed" || status === "cancelled") {
            try { await reader.cancel(); } catch {}
            return;
          }
          sep = buffer.indexOf("\\n\\n");
        }
      }
    }

    async function loadSessions() {
      try {
        const sessions = await client.sessions();
        const list = Array.isArray(sessions) ? sessions : (sessions.sessions || []);
        if (list.length === 0) {
          els.sessionList.innerHTML = '<div style="color:var(--text-dim);font-size:12px;">No sessions yet.</div>';
          return;
        }
        els.sessionList.innerHTML = list.slice(0, 30).map(s => {
          const time = new Date(s.createdAt || s.updatedAt || Date.now()).toLocaleString();
          return '<div class="session-item' + (s.id === currentSessionId ? " active" : "") + '" data-id="' + escapeHtml(s.id) + '">' +
            '<div class="title">' + escapeHtml(s.title || "(untitled)") + '</div>' +
            '<div class="time">' + escapeHtml(time) + '</div>' +
          '</div>';
        }).join("");
        els.sessionList.querySelectorAll(".session-item").forEach(item => {
          item.addEventListener("click", async () => {
            const id = item.getAttribute("data-id");
            await loadSession(id);
            closeDrawer();
          });
        });
      } catch (error) {
        els.sessionList.innerHTML = '<div style="color:var(--error);font-size:12px;">Failed to load: ' + escapeHtml(error.message) + '</div>';
      }
    }

    async function loadSession(id) {
      try {
        const session = await client.session(id);
        currentSessionId = id;
        els.title.textContent = session.title || "(untitled)";
        els.messages.innerHTML = "";
        const messages = session.messages || [];
        for (const msg of messages) {
          const role = msg.role === "user" ? "user" : "assistant";
          addMessage(role, msg.content || msg.text || "");
        }
        if (messages.length === 0) {
          els.messages.innerHTML = '<div class="empty">Empty session.</div>';
        }
      } catch (error) {
        addMessage("error", "Failed to load session: " + error.message);
      }
    }

    async function checkStatus() {
      try {
        const providers = await client.providers();
        els.indicator.classList.add("online");
        els.indicator.classList.remove("offline");
        els.endpointInfo.textContent = "Connected: " + location.host;
        const list = Array.isArray(providers) ? providers : (providers.providers || []);
        els.providerInfo.textContent = "Providers: " + list.map(p => p.name || p).join(", ");
      } catch (error) {
        els.indicator.classList.add("offline");
        els.indicator.classList.remove("online");
        els.endpointInfo.textContent = "Offline: " + (error.message || error);
      }
    }
    checkStatus();
    setInterval(checkStatus, 30000);
  </script>
</body>
</html>
`;
}
