"""Request/response models for the Mission Assistant (mirrored in frontend/src/features/compare/assistant/api.ts)."""
from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .prompt import MAX_CONTEXT_CHARS


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=40, description="The conversation so far, oldest first")
    context: dict[str, Any] = Field(default_factory=dict, description="The comparison as currently shown on the page")

    @field_validator("context")
    @classmethod
    def _context_size(cls, v: dict[str, Any]) -> dict[str, Any]:
        if len(json.dumps(v, default=str)) > MAX_CONTEXT_CHARS:
            raise ValueError(f"context is larger than {MAX_CONTEXT_CHARS} characters")
        return v

    @model_validator(mode="after")
    def _ends_with_question(self) -> "ChatRequest":
        if self.messages[-1].role != "user":
            raise ValueError("the last message must be the user's question")
        return self


class ChatResponse(BaseModel):
    reply: str
    model: str
    source: Literal["ai"] = "ai"


class AssistantStatus(BaseModel):
    available: bool
    reason: str | None = None  # not_configured | offline, when unavailable
    message: str | None = None
    model: str | None = None
