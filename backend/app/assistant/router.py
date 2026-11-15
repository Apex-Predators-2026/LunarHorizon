"""HTTP endpoints for the Mission Assistant (Member 4, Scenario Comparison).

The browser sends the conversation and the comparison it is looking at; this server adds the system instruction
and the API key and forwards it to the AI service. The assistant is read-only: nothing here changes scenarios,
requirements, rankings or Rescue plans.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..engine.net import offline
from . import client
from .config import settings
from .prompt import build_messages
from .schemas import AssistantStatus, ChatRequest, ChatResponse

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


@router.get("/status", summary="Whether the Mission Assistant can answer")
def get_status() -> AssistantStatus:
    """Configuration check only (no call to the AI service, nothing billed)."""
    s = settings()
    if not s.configured:
        return AssistantStatus(available=False, reason=client.NOT_CONFIGURED[0], message=client.NOT_CONFIGURED[1])
    if offline():
        return AssistantStatus(available=False, reason=client.OFFLINE[0], message=client.OFFLINE[1])
    return AssistantStatus(available=True, model=s.model)


@router.post("/chat", summary="Ask the Mission Assistant about the current comparison")
def post_chat(req: ChatRequest) -> ChatResponse:
    """503 with {reason, message} when the assistant can't answer (not configured, offline, service error).
    No answer is ever made up in that case."""
    history = [m.model_dump() for m in req.messages]
    try:
        reply, model = client.complete(build_messages(history, req.context), settings())
    except client.AssistantUnavailable as e:
        raise HTTPException(503, {"reason": e.reason, "message": e.message})
    return ChatResponse(reply=reply, model=model)
