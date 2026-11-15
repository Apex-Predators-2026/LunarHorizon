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


def test_instruction_covers_the_mission_report_snapshot():
    system = build_messages([{"role": "user", "content": "q"}], {})[0]["content"]
    for rule in ('"report" (null until the user generates one)', '"out_of_date" is true', "never from the live comparison",
                 'Name report sections only from "report.sections"', "open the last report"):
        assert rule in system, rule


def test_report_is_sent_as_its_own_message_with_its_state_first():
    q = [{"role": "user", "content": "Summarize my report."}]
    plain = build_messages(q, {"state": "ready"})
    assert len(plain) == 3 and "MISSION REPORT" not in plain[1]["content"]  # older pages: unchanged
    none = build_messages(q, {"state": "ready", "report": None})
    assert none[2]["content"].startswith("MISSION REPORT: none.")
    fresh = build_messages(q, {"state": "ready", "report": {"snapshot_id": "rpt-1", "out_of_date": False, "plans": []}})
    assert '"report"' not in fresh[1]["content"]  # not duplicated in the comparison context
    assert fresh[2]["content"].startswith("MISSION REPORT: the user HAS generated") and "Status: CURRENT" in fresh[2]["content"]
    stale = build_messages(q, {"report": {"snapshot_id": "rpt-1", "out_of_date": True}})
    assert "Status: OUT OF DATE" in stale[2]["content"]
    assert stale[-1] == q[-1]


def test_instruction_has_answer_layouts_for_report_questions():
    system = build_messages([{"role": "user", "content": "q"}], {})[0]["content"]
    for rule in ('"Summarize my report": ### Report status', '"Explain the final assessment"', "never name a winner it does not name",
                 '"Strengths / weaknesses of Scenario X"', "(UNKNOWN is not a failure)", '"Explain the communication (or solar) section"',
                 '"What does the report mean by UNKNOWN"', '"Which section shows ...": name the report section'):
        assert rule in system, rule
