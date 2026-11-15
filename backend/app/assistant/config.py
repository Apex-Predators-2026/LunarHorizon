"""Mission Assistant settings.

Read from the environment, or from backend/.env (git-ignored) for local runs. Variables:

    OPENROUTER_API_KEY    required for the assistant; without it the assistant reports "not configured"
    OPENROUTER_MODEL      optional, any OpenRouter model id (default: openai/gpt-4o-mini)
    OPENROUTER_BASE_URL   optional, an OpenAI-compatible endpoint (default: https://openrouter.ai/api/v1)
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


def load_env_file(path: Path | None = None) -> None:
    """Minimal KEY=VALUE reader (no dependency). Variables already set in the environment win."""
    path = ENV_FILE if path is None else path
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip().removeprefix("export ").strip()
        value = value.strip().strip('"').strip("'")
        if name and name not in os.environ:
            os.environ[name] = value


@dataclass(frozen=True)
class Settings:
    api_key: str | None
    model: str
    base_url: str
    timeout_s: float

    @property
    def configured(self) -> bool:
        return bool(self.api_key)


def settings() -> Settings:
    """Current settings. Read on every call, so a key added to .env works without restarting."""
    load_env_file()
    try:
        timeout = float(os.environ.get("ASSISTANT_TIMEOUT_S", "") or 45)
    except ValueError:
        timeout = 45.0
    return Settings(
        api_key=os.environ.get("OPENROUTER_API_KEY", "").strip() or None,
        model=os.environ.get("OPENROUTER_MODEL", "").strip() or DEFAULT_MODEL,
        base_url=(os.environ.get("OPENROUTER_BASE_URL", "").strip() or DEFAULT_BASE_URL).rstrip("/"),
        timeout_s=max(5.0, min(timeout, 120.0)),
    )
