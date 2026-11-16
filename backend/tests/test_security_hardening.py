"""Security and pre-deployment hardening tests (TDD RED -> GREEN)."""

import json
import os
import re
import urllib.request
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.main as main
import app.terrain_router as tr
from app import store
from app.engine import dem, ephem_local

client = TestClient(main.app)


@pytest.fixture(autouse=True)
def reset_security_state(monkeypatch, tmp_path):
    """Ensure rate limiters and env overrides do not bleed across tests."""
    from app.security import reset_rate_limiters

    reset_rate_limiters()
    monkeypatch.delenv("RATE_LIMIT_CHAT_PER_MIN", raising=False)
    monkeypatch.delenv("RATE_LIMIT_CUSTOM_SITE_PER_MIN", raising=False)
    monkeypatch.delenv("RATE_LIMIT_RESCUE_PER_MIN", raising=False)
    monkeypatch.delenv("TRUST_PROXY_HEADERS", raising=False)
    monkeypatch.delenv("MAX_CUSTOM_SITES", raising=False)
    monkeypatch.delenv("CORS_ALLOW_ORIGINS", raising=False)
    monkeypatch.setattr(store, "CUSTOM_DIR", tmp_path / "custom")
    yield
    reset_rate_limiters()


def test_security_headers_present_on_responses():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "camera=()" in r.headers["permissions-policy"]
    assert "default-src 'none'" in r.headers["content-security-policy"]
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert "strict-transport-security" not in r.headers  # plain HTTP localhost test

    https_r = client.get("/api/health", headers={"X-Forwarded-Proto": "https"})
    assert "max-age=31536000" in https_r.headers["strict-transport-security"]


def test_cors_origins_strips_wildcard(monkeypatch):
    monkeypatch.setenv("CORS_ALLOW_ORIGINS", "*, https://lunar.xyz/ ")
    assert main.cors_origins() == ["https://lunar.xyz"]
    monkeypatch.setenv("CORS_ALLOW_ORIGINS", "*")
    assert main.cors_origins() == []


def test_rate_limiting_blocks_excessive_assistant_calls_and_ignores_spoofed_xff(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_CHAT_PER_MIN", "2")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-test-not-a-real-key-0123456789")

    class StubStream:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps({"model": "test/m", "choices": [{"message": {"content": "ok"}}]}).encode()

    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=None: StubStream())
    payload = {"messages": [{"role": "user", "content": "Compare"}], "context": {}}

    assert client.post("/api/assistant/chat", json=payload, headers={"X-Forwarded-For": "10.0.0.1"}).status_code == 200
    assert client.post("/api/assistant/chat", json=payload, headers={"X-Forwarded-For": "10.0.0.2"}).status_code == 200
    blocked = client.post("/api/assistant/chat", json=payload, headers={"X-Forwarded-For": "10.0.0.3"})
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) >= 1


def test_rate_limiting_protects_custom_site_and_rescue(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_CUSTOM_SITE_PER_MIN", "1")
    monkeypatch.setenv("RATE_LIMIT_RESCUE_PER_MIN", "1")

    assert client.post("/api/sites/custom", json={"lat": -95, "lon": 10}).status_code == 422
    assert client.post("/api/sites/custom", json={"lat": -95, "lon": 10}).status_code == 429

    base = {
        "site": {"id": "peak-near-shackleton", "name": "Peak Near Shackleton", "lat": -89.01701, "lon": 126.27302},
        "landing_utc": "2027-01-07T00:00:00Z",
        "duration_days": 7,
    }
    r1 = client.post("/api/rescue", json={"original": base, "search": {"date_window_days": 2}})
    assert r1.status_code == 200
    r2 = client.post("/api/rescue", json={"original": base, "search": {"date_window_days": 2}})
    assert r2.status_code == 429


def test_custom_site_bounds_name_and_evicts_oldest_disk_entries(monkeypatch):
    long_name = "X" * 121
    assert client.post("/api/sites/custom", json={"lat": -89.1, "lon": 10.0, "name": long_name}).status_code == 422

    monkeypatch.setenv("MAX_CUSTOM_SITES", "2")
    monkeypatch.setattr(
        store,
        "analyze_site",
        lambda spec, ephemeris="local": {
            "site": {**spec, "ground_height_m": 0.0, "observer_height_m": 2.0},
            "horizon": {"azimuth_deg": [0.0], "elevation_deg": [0.0], "distance_m": [1000.0]},
            "summary": {
                "sunlit_pct": 100.0,
                "mean_sun_fraction_pct": 100.0,
                "earth_visible_pct": 100.0,
                "horizon_min_deg": 0.0,
                "horizon_max_deg": 0.0,
            },
            "timeline": {
                "time_utc": ["2027-01-01T00:00:00Z"],
                "sun_azimuth_deg": [0.0],
                "sun_elevation_deg": [1.0],
                "sun_horizon_deg": [0.0],
                "sun_visible_fraction": [1.0],
                "sun_visible": [True],
                "earth_azimuth_deg": [0.0],
                "earth_elevation_deg": [1.0],
                "earth_horizon_deg": [0.0],
                "earth_visible": [True],
                "earth_margin_deg": [1.0],
            },
        },
    )

    for idx, lat in enumerate((-89.1, -89.2, -89.3), start=1):
        res = client.post("/api/sites/custom", json={"lat": lat, "lon": 15.0})
        assert res.status_code == 200
        # Ensure deterministic ordering of mtimes for eviction test.
        created = store.CUSTOM_DIR / f"{res.json()['id']}.json"
        os.utime(created, (1_700_000_000 + idx * 10, 1_700_000_000 + idx * 10))

    saved_files = sorted(p.name for p in store.CUSTOM_DIR.glob("*.json"))
    assert len(saved_files) == 2
    assert store.custom_site_id(-89.1, 15.0) + ".json" not in saved_files


def test_rescue_search_rejects_unbounded_candidate_lists_or_grid():
    base = {
        "site": {"id": "peak-near-shackleton", "name": "Peak Near Shackleton", "lat": -89.01701, "lon": 126.27302},
        "landing_utc": "2027-01-07T00:00:00Z",
        "duration_days": 7,
    }
    too_many_sites = {"original": base, "search": {"candidate_site_ids": [f"s{i}" for i in range(51)]}}
    assert client.post("/api/rescue", json=too_many_sites).status_code == 422

    too_many_radii = {"original": base, "search": {"nearby_radii_km": [float(i + 1) for i in range(11)]}}
    assert client.post("/api/rescue", json=too_many_radii).status_code == 422

    huge_grid = {"original": base, "search": {"date_window_days": 365, "date_step_hours": 1}}
    assert client.post("/api/rescue", json=huge_grid).status_code == 422


def test_upstream_errors_never_leak_internal_urls_or_paths(monkeypatch):
    secret_detail = "https://internal-proxy.corp:8443/C:/Users/secret/token"

    monkeypatch.setattr(tr, "tile_heights", lambda *a, **kw: (_ for _ in ()).throw(OSError(secret_detail)))
    tile_r = client.get("/api/terrain/tile/5/0/0/0")
    assert tile_r.status_code == 502 and secret_detail not in tile_r.text

    monkeypatch.setattr(tr, "tile_heights", lambda *a, **kw: (_ for _ in ()).throw(dem.DownloadBusy(secret_detail)))
    busy_r = client.get("/api/terrain/tile/5/0/0/0")
    assert busy_r.status_code == 503 and secret_detail not in busy_r.text

    monkeypatch.setattr(tr.psr, "load", lambda: (_ for _ in ()).throw(OSError(secret_detail)))
    psr_r = client.get("/api/psr")
    assert psr_r.status_code == 502 and secret_detail not in psr_r.text

    monkeypatch.setattr(store, "analyze_site", lambda *a, **kw: (_ for _ in ()).throw(ConnectionError(secret_detail)))
    custom_r = client.post("/api/sites/custom", json={"lat": -89.44, "lon": 22.0})
    assert custom_r.status_code == 502
    assert "unavailable" in custom_r.json()["detail"]
    assert secret_detail not in custom_r.text

    monkeypatch.setattr(main, "verify", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError(secret_detail)))
    verify_r = client.get("/api/sites/connecting-ridge/verify", params={"time": "2027-01-12T03:00Z"})
    assert verify_r.status_code == 502 and secret_detail not in verify_r.text


def test_frontend_index_avoids_inline_scripts_and_has_launch_assets():
    frontend_dir = Path(__file__).resolve().parents[2] / "frontend"
    html = (frontend_dir / "index.html").read_text(encoding="utf-8")
    inline_scripts = re.findall(r"<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?</script>", html, flags=re.IGNORECASE)
    assert inline_scripts == []
    assert '<script src="/theme-init.js"></script>' in html
    assert re.search(r'<meta\s+name="description"\s+content="[^"]+"', html, flags=re.IGNORECASE)
    assert re.search(r'<meta\s+property="og:title"\s+content="[^"]+"', html, flags=re.IGNORECASE)
    assert (frontend_dir / "public" / "theme-init.js").is_file()
    assert (frontend_dir / "public" / "robots.txt").is_file()
