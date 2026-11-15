"""HTTP endpoints for the Mission Assistant (Member 4, Scenario Comparison).

The browser sends the conversation and the comparison it is looking at; this server adds the system instruction
and the API key and forwards it to the AI service. The assistant is read-only: nothing here changes scenarios,
requirements, rankings or Rescue plans.
"""
from __future__ import annotations

import json
from collections.abc import Iterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..engine.net import offline
from . import client
from .config import Settings, settings
from .prompt import build_messages
from .schemas import AssistantStatus, ChatRequest, ChatResponse

router = APIRouter(prefix="/api/assistant", tags=["assistant"])
STREAM_TYPE = "application/x-ndjson"


def _stream_chat(messages: list[dict], s: Settings) -> Iterator[str]:
    try:
        for event in client.stream_completion(messages, s):
            yield json.dumps(event) + "\n"
    except client.AssistantUnavailable as e:
        yield json.dumps({"type": "error", "reason": e.reason, "message": e.message}) + "\n"


@router.get("/status", summary="Whether the Mission Assistant can answer")
def get_status() -> AssistantStatus:
    """Configuration check only (no call to the AI service, nothing billed)."""
    s = settings()
    if not s.configured:
        return AssistantStatus(available=False, reason=client.NOT_CONFIGURED[0], message=client.NOT_CONFIGURED[1])
    if offline():
        return AssistantStatus(available=False, reason=client.OFFLINE[0], message=client.OFFLINE[1])
    return AssistantStatus(available=True, model=s.model)


@router.post("/chat", response_model=ChatResponse, summary="Ask the Mission Assistant about the current comparison")
def post_chat(req: ChatRequest, request: Request) -> ChatResponse | StreamingResponse:
    """Return JSON by default, or stream text deltas as application/x-ndjson."""
    history = [m.model_dump() for m in req.messages]
    messages = build_messages(history, req.context)
    s = settings()
    if any(value.strip() == STREAM_TYPE for value in request.headers.get("accept", "").split(",")):
        return StreamingResponse(_stream_chat(messages, s), media_type=STREAM_TYPE, headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
    try:
        reply, model = client.complete(messages, s)
    except client.AssistantUnavailable as e:
        raise HTTPException(503, {"reason": e.reason, "message": e.message})
    return ChatResponse(reply=reply, model=model)
