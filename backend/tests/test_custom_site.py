"""POST /api/sites/custom (the Drop pin coordinate form): every failure is an explained status, never a bare 500.

Regression: a venv set up without Skyfield (listed in requirements.txt but once labelled "validation only") made every
new pin fail with an unhandled ModuleNotFoundError -> "Internal Server Error". These tests reproduce that at the real
import site (engine/ephem_local.setup) and pin the status codes of the other failure classes. No network: terrain and
ephemeris work is stubbed, and custom records go to a temporary directory, never data/sites/custom.
"""

import sys

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app import store
from app.engine import ephem_local, net

client = TestClient(main.app, raise_server_exceptions=False)
PIN = {"lat": -89.3141, "lon": 123.4567}  # not a stored site; isolated by the fixture below anyway


@pytest.fixture(autouse=True)
def isolated_custom_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "CUSTOM_DIR", tmp_path / "custom")
    ephem_local.setup.cache_clear()  # setup() is lru_cached: never let one test's kernels leak into another
    yield
    ephem_local.setup.cache_clear()


def _block_skyfield(monkeypatch):
    # A None entry in sys.modules makes `import skyfield.api` raise ImportError, exactly like a missing package.
    for name in ("skyfield", "skyfield.api", "skyfield.planetarylib"):
        monkeypatch.setitem(sys.modules, name, None)


def test_missing_skyfield_is_a_typed_error_not_module_not_found(monkeypatch):
    _block_skyfield(monkeypatch)
    with pytest.raises(ephem_local.LocalEphemerisUnavailable, match="pip install -r backend/requirements.txt"):
        ephem_local.local_ephemeris("sun", -89.3, 123.4, "2027-01-01", "2027-01-02")


def test_missing_skyfield_returns_503_with_the_fix_instead_of_500(monkeypatch):
    _block_skyfield(monkeypatch)

    def analyze_site(spec, ephemeris):  # terrain stubbed; the ephemeris step is the real code path
        assert ephemeris == "local"
        ephem_local.local_ephemeris("sun", spec["lat"], spec["lon"], "2027-01-01", "2027-01-02")

    monkeypatch.setattr(store, "analyze_site", analyze_site)
    r = client.post("/api/sites/custom", json=PIN)
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert "skyfield" in detail and "requirements.txt" in detail
    assert not (store.CUSTOM_DIR / f"{store.custom_site_id(PIN['lat'], PIN['lon'])}.json").exists()  # nothing half-written


def test_offline_without_cached_terrain_explains_the_limitation(monkeypatch):
    def analyze_site(spec, ephemeris):
        raise net.OfflineError("offline mode (LUNAR_OFFLINE=1), not in the cache: https://trek.nasa.gov/...")

    monkeypatch.setattr(store, "analyze_site", analyze_site)
    r = client.post("/api/sites/custom", json=PIN)
    assert r.status_code == 503
    assert "offline mode" in r.json()["detail"]


def test_upstream_nasa_outage_is_a_502(monkeypatch):
    def analyze_site(spec, ephemeris):
        raise ConnectionError("Moon Trek timed out")  # an OSError subclass, as urllib raises

    monkeypatch.setattr(store, "analyze_site", analyze_site)
    r = client.post("/api/sites/custom", json=PIN)
    assert r.status_code == 502
    assert "unavailable" in r.json()["detail"]


@pytest.mark.parametrize(
    "body",
    [{"lat": -95, "lon": 10}, {"lat": -89, "lon": 400}, {"lat": -89}, {"lon": 10}, {"lat": "south", "lon": 10}, {"lat": None, "lon": 10}, {}],
)
def test_invalid_or_missing_fields_are_422(body):
    r = client.post("/api/sites/custom", json=body)
    assert r.status_code == 422
    assert r.json()["detail"]  # field-level messages from the request model


def test_verify_with_jpl_reports_a_missing_skyfield_as_503(monkeypatch):
    _block_skyfield(monkeypatch)
    monkeypatch.setattr(main, "verify", lambda *_: ephem_local.setup())  # the real import inside the live check
    r = client.get("/api/sites/connecting-ridge/verify", params={"time": "2027-01-12T03:00Z"})
    assert r.status_code == 503
    assert "skyfield" in r.json()["detail"]
