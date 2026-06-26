from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


@dataclass
class MagiEndpoint:
    base_url: str
    device_id: str = ""
    token: str = ""


@dataclass
class DispatchResult:
    session_id: str
    job_id: str
    text: str
    error: str | None = None


def _headers(endpoint: MagiEndpoint) -> dict[str, str]:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if endpoint.device_id:
        headers["X-Magi-Device-Id"] = endpoint.device_id
    if endpoint.token:
        headers["Authorization"] = f"Bearer {endpoint.token}"
    return headers


def _request(
    endpoint: MagiEndpoint,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    timeout: float = 30,
) -> tuple[int, str]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = Request(
        f"{endpoint.base_url.rstrip('/')}{path}",
        data=data,
        headers=_headers(endpoint),
        method=method,
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except HTTPError as err:
        payload = err.read().decode("utf-8", errors="replace")
        return err.code, payload
    except URLError as err:
        return 0, str(err.reason)


def fetch_health(endpoint: MagiEndpoint) -> dict[str, Any]:
    status, body = _request(endpoint, "GET", "/health")
    if status != 200:
        return {"ok": False, "status": status, "error": body[:500]}
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"ok": False, "error": body[:500]}


def probe_peer(name: str, url: str) -> dict[str, Any]:
    endpoint = MagiEndpoint(base_url=url)
    health = fetch_health(endpoint)
    return {"name": name, "url": url, "health": health}


def format_cluster_status(router: MagiEndpoint, manual_peers: list[tuple[str, str]]) -> str:
    lines = ["**Magi 集群状态**", ""]
    router_health = fetch_health(router)
    lines.append(f"• **router** `{router.base_url}` — {'online' if router_health.get('ok') else 'offline'}")
    if not router_health.get("ok"):
        err = router_health.get("error") or router_health
        lines.append(f"  {err}")
    for name, url in manual_peers:
        peer = probe_peer(name, url)
        ok = peer["health"].get("ok")
        lines.append(f"• **{name}** `{url}` — {'online' if ok else 'offline'}")
    lines.append("")
    lines.append("_Tip: 配置 router.device_id/token 后可下发任务。_")
    return "\n".join(lines)


def dispatch_prompt(
    endpoint: MagiEndpoint,
    prompt: str,
    *,
    model: str = "main",
    timeout_seconds: int = 600,
) -> DispatchResult:
    status, body = _request(
        endpoint,
        "POST",
        "/jobs",
        {"prompt": prompt, "model": model, "modelAlias": model},
        timeout=60,
    )
    if status == 401:
        return DispatchResult("", "", "", error="Magi 鉴权失败：请在 config.local.toml 填写 magi pair 生成的 device_id/token")
    if status != 200:
        return DispatchResult("", "", "", error=f"创建任务失败 HTTP {status}: {body[:400]}")

    try:
        envelope = json.loads(body)
    except json.JSONDecodeError:
        return DispatchResult("", "", "", error=f"无效响应: {body[:400]}")

    session_id = str(envelope.get("sessionId") or "")
    job_id = str(envelope.get("jobId") or "")
    message = envelope.get("message")
    if isinstance(message, str) and message.strip():
        return DispatchResult(session_id, job_id, message.strip())

    if not job_id:
        return DispatchResult(session_id, "", "", error=f"缺少 jobId: {body[:400]}")

    deadline = time.time() + timeout_seconds
    assistant_text = ""
    while time.time() < deadline:
        job_status, job_body = _request(endpoint, "GET", f"/jobs/{job_id}", timeout=30)
        if job_status != 200:
            time.sleep(0.5)
            continue
        try:
            job = json.loads(job_body).get("job", {})
        except json.JSONDecodeError:
            time.sleep(0.5)
            continue

        meta = job.get("metadata") or {}
        if isinstance(meta.get("result"), str):
            assistant_text = meta["result"]
        status_value = str(job.get("status") or "")
        if status_value in {"completed", "failed", "cancelled", "recorded"}:
            if status_value == "failed":
                err = meta.get("error") or assistant_text or job_body[:400]
                return DispatchResult(session_id, job_id, assistant_text, error=str(err))
            if assistant_text:
                return DispatchResult(session_id, job_id, assistant_text)
            # Fall back to events poll
            break
        time.sleep(1)

    # Events fallback
    ev_status, ev_body = _request(endpoint, "GET", f"/jobs/{job_id}/events", timeout=30)
    if ev_status == 200:
        try:
            events = json.loads(ev_body).get("events", [])
            chunks: list[str] = []
            for event in events:
                if not isinstance(event, dict):
                    continue
                if event.get("type") == "assistant_delta" and isinstance(event.get("text"), str):
                    chunks.append(event["text"])
                if event.get("type") == "assistant_message" and isinstance(event.get("text"), str):
                    chunks = [event["text"]]
            if chunks:
                return DispatchResult(session_id, job_id, "".join(chunks).strip())
        except json.JSONDecodeError:
            pass

    return DispatchResult(
        session_id,
        job_id,
        assistant_text,
        error="任务超时或尚无结果，请稍后重试",
    )
