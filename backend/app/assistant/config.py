"""Mission Assistant settings.

Read from the environment, or from backend/.env (git-ignored) for local runs. Variables:

    OPENROUTER_API_KEY    required for the assistant; without it the assistant reports "not configured"
    OPENROUTER_MODEL      optional, any OpenRouter model id (default: openai/gpt-4o-mini)
    OPENROUTER_BASE_URL   optional, an OpenAI-compatible endpoint (default: https://openrouter.ai/api/v1)
    OPENROUTER_HTTP_REFERER optional, the public frontend URL used for OpenRouter attribution
    ASSISTANT_TIMEOUT_S   optional, seconds to wait for an answer (default: 45)

The key stays on the server: it is never sent to the browser, logged or returned in an error.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parents[2] / ".env"
DEFAULT_MODEL = "openai/gpt-4o-mini"
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_HTTP_REFERER = "http://localhost:5173"


def load_env_file(path: Path | None = None) -> dict[str, str]:
    """Read KEY=VALUE pairs without overriding process environment variables."""
    path = ENV_FILE if path is None else path
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip().removeprefix("export ").strip()
        value = value.strip().strip('"').strip("'")
        if name:
            values[name] = value
    return values


@dataclass(frozen=True)
class Settings:
    api_key: str | None
    model: str
    base_url: str
    http_referer: str
    timeout_s: float

    @property
    def configured(self) -> bool:
        return bool(self.api_key)


def settings() -> Settings:
    """Read current settings; process environment values take precedence over backend/.env."""
    file_values = load_env_file()

    def value(name: str) -> str:
        return os.environ.get(name, file_values.get(name, "")).strip()

    try:
        timeout = float(value("ASSISTANT_TIMEOUT_S") or 45)
    except ValueError:
        timeout = 45.0
    return Settings(
        api_key=value("OPENROUTER_API_KEY") or None,
        model=value("OPENROUTER_MODEL") or DEFAULT_MODEL,
        base_url=(value("OPENROUTER_BASE_URL") or DEFAULT_BASE_URL).rstrip("/"),
        http_referer=value("OPENROUTER_HTTP_REFERER") or DEFAULT_HTTP_REFERER,
        timeout_s=max(5.0, min(timeout, 120.0)),
    )
