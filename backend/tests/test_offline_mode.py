"""The offline switch (LUNAR_OFFLINE=1, engine/net.py): cached data still served, downloads refused at once."""

import pytest

from app.engine import net


def test_offline_refuses_downloads_but_serves_the_cache(tmp_path, monkeypatch):
    cached = tmp_path / "have.bin"
    cached.write_bytes(b"data")
    monkeypatch.setenv("LUNAR_OFFLINE", "1")
    assert net.offline()
    assert net.fetch_cached("https://example.invalid/have.bin", cached) == cached  # from the cache
    with pytest.raises(net.OfflineError):
        net.fetch_cached("https://example.invalid/missing.bin", tmp_path / "missing.bin")
    assert not (tmp_path / "missing.bin").exists()


def test_offline_error_is_an_oserror_so_the_api_reports_an_outage():
    assert issubclass(net.OfflineError, OSError)


def test_online_by_default(monkeypatch):
    monkeypatch.delenv("LUNAR_OFFLINE", raising=False)
    assert not net.offline()
    net.require_online("https://example.invalid/x")  # no error
    monkeypatch.setenv("LUNAR_OFFLINE", "0")
    assert not net.offline()


def test_terrain_blocks_fail_at_once_offline(tmp_path, monkeypatch):
    # A block not in the cache: straight to the error, not after the download retries (seconds each).
    import time

    from app.engine import dem

    monkeypatch.setenv("LUNAR_OFFLINE", "1")
    store = dem._BlockStore(root=tmp_path)  # an empty cache
    src = next(iter(dem.SOURCES.values()))
    t0 = time.time()
    with pytest.raises(net.OfflineError):
        store.get(src, 0, 0, 0)
    assert time.time() - t0 < 1


def test_live_jpl_check_says_it_needs_the_internet_when_offline(monkeypatch):
    from fastapi.testclient import TestClient

    import app.main as main

    def offline(*_):
        raise net.OfflineError("offline mode (LUNAR_OFFLINE=1), not in the cache: https://ssd.jpl.nasa.gov/...")

    monkeypatch.setattr(main, "verify", offline)
    r = TestClient(main.app).get("/api/sites/connecting-ridge/verify", params={"time": "2027-01-12T03:00Z"})
    assert r.status_code == 503
    assert "internet connection" in r.json()["detail"] and "https://" not in r.json()["detail"]
