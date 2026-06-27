from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable

from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .interactions import FeishuTarget, InteractionHub


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
        reason = str(err.reason)
        if "Connection refused" in reason or "connection refused" in reason.lower():
            return 0, f"无法连接 Magi router（{endpoint.base_url} 未运行）。请在 Mac 上启动: MAGI_CONFIG_DIR=~/.magi-router magi daemon start"
        return 0, reason


def refresh_pairing(endpoint: MagiEndpoint, name: str = "feishu-bridge") -> MagiEndpoint | None:
    """Mint a new pair token from loopback /pairing (10 min TTL). Returns updated endpoint."""
    status, body = _request(
        MagiEndpoint(base_url=endpoint.base_url),
        "POST",
        "/pairing",
        {"name": name},
        timeout=15,
    )
    if status != 200:
        return None
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None
    device_id = str(data.get("deviceId") or "")
    token = str(data.get("token") or "")
    if not device_id or not token:
        return None
    return MagiEndpoint(base_url=endpoint.base_url, device_id=device_id, token=token)


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


def assemble_assistant_text_from_events(events: list[dict[str, Any]]) -> str:
    """Rebuild final assistant text from Magi audit events (newest-first list)."""
    chronological = list(reversed(events))
    best = ""
    for event in chronological:
        if not isinstance(event, dict):
            continue
        action = str(event.get("action") or event.get("type") or "")
        meta = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
        message = str(event.get("message") or "")

        if action == "agent.assistant.message" and isinstance(meta.get("text"), str):
            if len(meta["text"]) >= len(best):
                best = meta["text"]
        elif action == "agent.text.delta" and isinstance(meta.get("text"), str):
            # metadata.text is the full streamed buffer — never concatenate previews.
            if len(meta["text"]) >= len(best):
                best = meta["text"]
        elif action == "agent.query.done" and isinstance(meta.get("text"), str):
            best = meta["text"]
        elif action == "agent.query.completed":
            last = meta.get("lastAssistantMessage")
            if isinstance(last, str) and len(last) >= len(best):
                best = last
            elif message and len(message) >= len(best):
                best = message
    return best.strip()


def fetch_job_assistant_text(endpoint: MagiEndpoint, job_id: str, session_id: str = "") -> str:
    """Load the best available assistant reply for a completed job."""
    ev_status, ev_body = _request(endpoint, "GET", f"/jobs/{job_id}/events?limit=500", timeout=60)
    if ev_status == 200:
        try:
            events = json.loads(ev_body).get("events", [])
            text = assemble_assistant_text_from_events(events)
            if text:
                return text
        except json.JSONDecodeError:
            pass

    if session_id:
        ev_status, ev_body = _request(
            endpoint, "GET", f"/sessions/{session_id}/events?limit=500", timeout=60
        )
        if ev_status == 200:
            try:
                events = json.loads(ev_body).get("events", [])
                text = assemble_assistant_text_from_events(events)
                if text:
                    return text
            except json.JSONDecodeError:
                pass
    return ""


def fetch_job_interactions(endpoint: MagiEndpoint, job_id: str) -> list[dict[str, Any]]:
    status, body = _request(endpoint, "GET", f"/jobs/{job_id}/interactions", timeout=30)
    if status != 200:
        return []
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return []
    interactions = data.get("interactions")
    return interactions if isinstance(interactions, list) else []


def resolve_job_approval(
    endpoint: MagiEndpoint, job_id: str, tool_use_id: str, *, approved: bool = True
) -> bool:
    status, _body = _request(
        endpoint,
        "POST",
        f"/jobs/{job_id}/approvals/{tool_use_id}",
        {"decision": "approve" if approved else "deny", "responder": "feishu-bridge"},
        timeout=30,
    )
    return status == 200


def resolve_job_question(
    endpoint: MagiEndpoint,
    job_id: str,
    tool_use_id: str,
    answer: dict[str, Any],
) -> bool:
    payload = dict(answer)
    payload["responder"] = "feishu-bridge"
    status, _body = _request(
        endpoint,
        "POST",
        f"/jobs/{job_id}/questions/{tool_use_id}",
        payload,
        timeout=30,
    )
    return status == 200


def _handle_pending_interactions(
    endpoint: MagiEndpoint,
    job_id: str,
    *,
    permission_mode: str,
    interaction_hub: InteractionHub | None,
    feishu_target: FeishuTarget | None,
    interaction_timeout_seconds: float,
    handled_questions: set[str],
    send_question: Callable[[FeishuTarget, list[dict[str, Any]], str, str], None] | None,
) -> None:
    pending_items = fetch_job_interactions(endpoint, job_id)
    for item in pending_items:
        if not isinstance(item, dict):
            continue
        if str(item.get("status") or "") != "pending":
            continue
        kind = str(item.get("kind") or "")
        tool_use_id = str(item.get("toolUseId") or "")
        if not tool_use_id:
            continue

        if kind == "approval":
            if permission_mode == "bypassPermissions":
                resolve_job_approval(endpoint, job_id, tool_use_id, approved=True)
            continue

        if kind != "question" or tool_use_id in handled_questions:
            continue
        if interaction_hub is None or feishu_target is None or send_question is None:
            continue

        question_payload = item.get("question")
        if not isinstance(question_payload, dict):
            continue
        questions = question_payload.get("questions")
        if not isinstance(questions, list) or not questions:
            continue

        handled_questions.add(tool_use_id)
        answer = interaction_hub.wait_for_answer(
            target=feishu_target,
            job_id=job_id,
            tool_use_id=tool_use_id,
            endpoint_key=endpoint.base_url,
            questions=questions,
            send_prompt=send_question,
            timeout_seconds=interaction_timeout_seconds,
        )
        if answer:
            resolve_job_question(endpoint, job_id, tool_use_id, answer)


def dispatch_prompt(
    endpoint: MagiEndpoint,
    prompt: str,
    *,
    model: str = "main",
    timeout_seconds: int = 600,
    permission_mode: str = "bypassPermissions",
    interaction_mode: str = "client",
    feishu_target: FeishuTarget | None = None,
    interaction_hub: InteractionHub | None = None,
    interaction_timeout_seconds: float = 300.0,
    send_question: Callable[[FeishuTarget, list[dict[str, Any]], str, str], None] | None = None,
    session_id: str = "",
    cwd: str = "",
) -> DispatchResult:
    wrapped_prompt = prompt
    job_body_payload: dict[str, Any] = {
        "prompt": wrapped_prompt,
        "model": model,
        "modelAlias": model,
        "background": True,
        "permissionMode": permission_mode,
        "interactionMode": interaction_mode,
    }
    if session_id:
        job_body_payload["sessionId"] = session_id
    if cwd:
        job_body_payload["cwd"] = cwd

    def _create_job(payload: dict[str, Any]) -> tuple[int, str, MagiEndpoint]:
        nonlocal endpoint
        status, body = _request(endpoint, "POST", "/jobs", payload, timeout=30)
        if status == 401:
            refreshed = refresh_pairing(endpoint)
            if refreshed:
                endpoint = refreshed
                status, body = _request(endpoint, "POST", "/jobs", payload, timeout=30)
        return status, body, endpoint

    status, body, endpoint = _create_job(job_body_payload)
    if status == 404 and session_id and "session not found" in body.lower():
        job_body_payload.pop("sessionId", None)
        session_id = ""
        status, body, endpoint = _create_job(job_body_payload)
    if status == 401:
        return DispatchResult(
            "",
            "",
            "",
            error="Magi 鉴权失败：pair token 已过期。请在本机运行 magi pair feishu-bridge 并更新 config.local.toml",
        )
    if status == 0:
        return DispatchResult("", "", "", error=f"无法连接 Magi router: {body[:400]}")
    if status == 401:
        return DispatchResult("", "", "", error="Magi 鉴权失败：请在 config.local.toml 填写 magi pair 生成的 device_id/token")
    if status not in {200, 202}:
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
    handled_questions: set[str] = set()
    while time.time() < deadline:
        _handle_pending_interactions(
            endpoint,
            job_id,
            permission_mode=permission_mode,
            interaction_hub=interaction_hub,
            feishu_target=feishu_target,
            interaction_timeout_seconds=interaction_timeout_seconds,
            handled_questions=handled_questions,
            send_question=send_question,
        )

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
            full_text = assistant_text or fetch_job_assistant_text(endpoint, job_id, session_id)
            if full_text:
                return DispatchResult(session_id, job_id, full_text)
            break
        time.sleep(1)

    full_text = fetch_job_assistant_text(endpoint, job_id, session_id)
    if full_text:
        return DispatchResult(session_id, job_id, full_text)

    return DispatchResult(
        session_id,
        job_id,
        assistant_text,
        error="任务超时或尚无结果，请稍后重试",
    )
