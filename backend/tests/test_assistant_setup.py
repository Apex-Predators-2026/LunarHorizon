"""Mission Assistant setup: a machine without a key gets clear instructions; the prompt covers withheld figures."""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.assistant import config
from app.assistant.prompt import build_messages
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def no_key(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "ENV_FILE", tmp_path / "missing.env")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)


def test_not_configured_message_says_how_to_turn_the_assistant_on():
    s = client.get("/api/assistant/status").json()
    assert s["available"] is False and s["reason"] == "not_configured"
    assert "backend/.env" in s["message"] and ".env.example" in s["message"] and "Check again" in s["message"]


def test_example_env_file_names_the_key_but_holds_none():
    text = (Path(config.__file__).resolve().parents[2] / ".env.example").read_text(encoding="utf-8")
    assert "OPENROUTER_API_KEY=\n" in text.replace("\r\n", "\n")
    assert "sk-or-v1-" not in text.replace("starts with sk-or-v1-", "")


def test_instruction_explains_withheld_figures():
    system = build_messages([{"role": "user", "content": "q"}], {})[0]["content"]
    assert '"figures_withheld"' in system and "withheld, not zero" in system
