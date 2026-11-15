"""OpenAI-compatible chat completion over the standard library (no SDK dependency).

Every failure becomes AssistantUnavailable with a short reason code and a user-facing message. The provider's
own error text is not passed through, and the key never appears in a message.
"""
from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager

from ..engine.net import offline  # importing engine.net also makes HTTPS use the OS certificate store
from .config import Settings


class AssistantUnavailable(Exception):
    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason
        self.message = message


NOT_CONFIGURED = (
    "not_configured",
    "The Mission Assistant is not configured on this server: set OPENROUTER_API_KEY in the backend environment "
    "(or backend/.env for local development), then press Check again. The comparison itself works without it.",
)
OFFLINE = (
    "offline",
    "The backend is in offline mode (LUNAR_OFFLINE=1), so the Mission Assistant cannot reach its AI service. "
    "The comparison itself works offline.",
)


@contextmanager
def _open_completion(messages: list[dict], s: Settings, temperature: float, max_tokens: int, *, streaming: bool = False):
    if not s.api_key:
        raise AssistantUnavailable(*NOT_CONFIGURED)
    if offline():
        raise AssistantUnavailable(*OFFLINE)
    payload = {"model": s.model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
    if streaming:
        payload["stream"] = True
    body = json.dumps(payload)
    req = urllib.request.Request(
        f"{s.base_url}/chat/completions",
        data=body.encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {s.api_key}",
            "Content-Type": "application/json",
            # OpenRouter's optional app attribution headers (no user data).
            "HTTP-Referer": s.http_referer,
            "X-Title": "Lunar Landing Site Navigator",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=s.timeout_s) as res:
            yield res
    except urllib.error.HTTPError as e:
        raise AssistantUnavailable(*_http_reason(e.code)) from None
    except (socket.timeout, TimeoutError):
        raise AssistantUnavailable("timeout", "The AI service took too long to answer. Try again.") from None
    except (urllib.error.URLError, OSError):
        raise AssistantUnavailable("network", "Couldn't reach the AI service (no connection?). Try again in a moment.") from None
    except ValueError:
        raise AssistantUnavailable("provider_error", "The AI service sent an unreadable answer. Try again.") from None


def _check_provider_error(data: dict) -> None:
    if data.get("error"):
        code = data["error"].get("code") if isinstance(data["error"], dict) else None
        raise AssistantUnavailable(*_http_reason(code if isinstance(code, int) else 502))


def complete(messages: list[dict], s: Settings, *, temperature: float = 0.1, max_tokens: int = 1100) -> tuple[str, str]:
    """Send the conversation and return (reply text, model that answered)."""
    with _open_completion(messages, s, temperature, max_tokens) as res:
        data = json.loads(res.read().decode("utf-8"))
    if isinstance(data, dict):
        _check_provider_error(data)
    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        text = None
    if not isinstance(text, str) or not text.strip():
        raise AssistantUnavailable("provider_error", "The AI service returned an empty answer. Try again.")
    return text.strip(), str(data.get("model") or s.model)


def stream_completion(messages: list[dict], s: Settings) -> Iterator[dict[str, str]]:
    """Translate provider SSE into text deltas and one terminal model event."""
    model = s.model
    received_text = False
    with _open_completion(messages, s, 0.1, 1100, streaming=True) as res:
        for line in res:
            if not line.startswith(b"data:"):
                continue
            payload = line[5:].strip()
            if payload == b"[DONE]":
                if not received_text:
                    raise AssistantUnavailable("provider_error", "The AI service returned an empty answer. Try again.")
                yield {"type": "done", "model": model}
                return
            data = json.loads(payload)
            if not isinstance(data, dict):
                raise ValueError("Expected a stream event object")
            _check_provider_error(data)
            model = str(data.get("model") or model)
            choices = data.get("choices") or []
            if not isinstance(choices, list) or (choices and not isinstance(choices[0], dict)):
                raise ValueError("Invalid stream choices")
            if not choices:
                continue
            choice = choices[0]
            if choice.get("finish_reason") == "error":
                raise AssistantUnavailable(*_http_reason(502))
            delta = choice.get("delta") or {}
            if not isinstance(delta, dict):
                raise ValueError("Invalid stream delta")
            text = delta.get("content")
            if isinstance(text, str) and text:
                received_text = received_text or bool(text.strip())
                yield {"type": "delta", "text": text}
    raise AssistantUnavailable("network", "The AI response was interrupted. Try again.")


def _http_reason(code: int) -> tuple[str, str]:
    if code in (401, 403):
        return "auth", "The AI service rejected this server's API key. Check OPENROUTER_API_KEY in backend/.env."
    if code == 402:
        return "credits", "The AI service account has no credits left."
    if code == 429:
        return "rate_limited", "The AI service is busy (rate limit). Wait a few seconds and try again."
    if code in (400, 404, 422):
        return "provider_error", "The AI service could not handle this request (check OPENROUTER_MODEL)."
    return "provider_error", "The AI service had a problem answering. Try again in a moment."
