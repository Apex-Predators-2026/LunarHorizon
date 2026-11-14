"""Long Horizons ranges are fetched per calendar year and stitched (no network)."""

import numpy as np

import app.engine.ephemeris as eph


def _fake_fetch(calls):
    def fetch(body, lat, lon, start, stop, step, alt_km):
        calls.append((start, stop))
        t = np.arange(np.datetime64(start.replace(" ", "T"), "h"), np.datetime64(stop.replace(" ", "T"), "h") + np.timedelta64(1, "h"))
        t = t.astype("datetime64[s]")
        x = t.astype("int64").astype(float)  # a value that identifies each hour
        return eph.Ephemeris(body, t, x % 360, x, np.full(t.size, 0.27))

    return fetch


def test_five_years_are_fetched_per_year_and_stitched_without_gaps_or_repeats(monkeypatch):
    calls = []
    monkeypatch.setattr(eph, "_fetch_one", _fake_fetch(calls))
    e = eph.fetch_ephemeris("sun", -89.5, 210.0, "2026-01-01", "2031-01-01")
    assert calls == [(f"{y}-01-01", f"{y + 1}-01-01") for y in range(2026, 2031)]
    hours = (np.datetime64("2031-01-01") - np.datetime64("2026-01-01")).astype("timedelta64[h]").astype(int) + 1
    assert e.times.size == hours == 43825  # both ends included, like one big request
    assert np.all(np.diff(e.times.astype("int64")) == 3600)
    assert np.array_equal(e.elevation_deg, e.times.astype("int64").astype(float))  # values stay with their hour


def test_short_ranges_are_one_request(monkeypatch):
    calls = []
    monkeypatch.setattr(eph, "_fetch_one", _fake_fetch(calls))
    eph.fetch_ephemeris("earth", -89.5, 210.0, "2027-01-12 03:00", "2027-01-12 06:00")
    assert calls == [("2027-01-12 03:00", "2027-01-12 06:00")]


def test_chunks_start_and_end_mid_year():
    assert eph.year_chunks("2026-06-15 12:00", "2028-03-01") == [
        ("2026-06-15 12:00", "2027-01-01"),
        ("2027-01-01", "2028-01-01"),
        ("2028-01-01", "2028-03-01"),
    ]
