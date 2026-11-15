"""Block cache robustness: damaged files, offline fallback for tiles, bounded waits, compact imagery."""

import threading

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import terrain_router as tr
from app.engine import dem
from app.engine.dem import DemSource
from app.engine.net import OfflineError

SRC = DemSource("fake", "Fake", "sp", 100, (0, 0, 1000, 1000), 100)


class CountingStore(dem._BlockStore):
    """A real block store (disk + memory) whose downloads return a constant block."""

    def __init__(self, root, value=7.0):
        super().__init__(root)
        self.value = value
        self.downloads = 0

    def _download(self, src, level, bx, by):
        self.downloads += 1
        return np.full((4, 4), self.value, dtype=np.float32)


def test_damaged_cache_file_is_downloaded_again(tmp_path, monkeypatch):
    monkeypatch.delenv("LUNAR_OFFLINE", raising=False)
    path = tmp_path / "fake" / "0" / "0_0.npy"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"\x93NUMPY cut off by a crash")
    store = CountingStore(tmp_path)
    block = store.get(SRC, 0, 0, 0)
    assert store.downloads == 1 and (block == 7).all()
    assert np.load(path).shape == (4, 4)  # replaced by a good file
    assert not list(path.parent.glob("*.part"))


def test_damaged_cache_file_offline_is_an_offline_error(tmp_path, monkeypatch):
    monkeypatch.setenv("LUNAR_OFFLINE", "1")
    path = tmp_path / "fake" / "0" / "0_0.npy"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"garbage")
    with pytest.raises(OfflineError):
        CountingStore(tmp_path).get(SRC, 0, 0, 0)


def test_imagery_blocks_are_stored_as_bytes(tmp_path, monkeypatch):
    monkeypatch.delenv("LUNAR_OFFLINE", raising=False)
    img = DemSource("img", "Fake", "sp", 100, (0, 0, 1000, 1000), 100, "U8", True)

    class Img(CountingStore):
        def _download(self, src, level, bx, by):
            return np.array([[np.nan, 5.0], [200.0, 0.0]], dtype=np.float32)

    block = Img(tmp_path).get(img, 0, 0, 0)
    stored = np.load(tmp_path / "img" / "0" / "0_0.npy")
    assert stored.dtype == np.uint8 and stored.tolist() == [[0, 5], [200, 0]]
    assert np.isnan(block[0, 0]) and np.isnan(block[1, 1]) and block[0, 1] == 5 and block[1, 0] == 200


def test_waiting_for_a_stalled_block_download_gives_up(tmp_path, monkeypatch):
    monkeypatch.setattr(dem, "WAIT_S", 0.2)
    store = CountingStore(tmp_path)
    key = (SRC.name, 0, 0, 0)
    lock = store.key_locks.setdefault(key, threading.Lock())
    lock.acquire()  # another request's download of this block is stuck
    try:
        with pytest.raises(dem.DownloadBusy):
            store.get(SRC, 0, 0, 0)
    finally:
        lock.release()
    assert store.get(SRC, 0, 0, 0)[0, 0] == 7  # fine once it's free


def test_download_busy_is_an_oserror_and_a_503_for_tiles(monkeypatch):
    assert issubclass(dem.DownloadBusy, OSError)

    def busy(*_, **__):
        raise dem.DownloadBusy("no Moon Trek download slot")

    monkeypatch.setattr(tr, "tile_heights", busy)
    tr._tile_payload.cache_clear()
    from app.main import app

    r = TestClient(app).get("/api/terrain/tile/5/3/1/1")
    assert r.status_code == 503


class OfflineFinestStore(dem._BlockStore):
    """sp5 / sp20 not cached (offline errors); the coarser products have data."""

    def get(self, src, level, bx, by):
        if src.name in ("sp5", "sp20"):
            raise OfflineError(f"not cached: {src.name}")
        return np.full((dem.block_px(src, level),) * 2, {"sp30": 30.0, "sp100": 100.0}.get(src.name, 1.0), dtype=np.float32)


def test_tiles_fall_back_to_coarser_cached_data_offline():
    lat, lon = np.array([-89.5, -89.6]), np.array([10.0, 40.0])
    with pytest.raises(OfflineError):  # horizons (the default) stay strict
        dem.sample_latlon(lat, lon, 5, OfflineFinestStore())
    z = dem.sample_latlon(lat, lon, 5, OfflineFinestStore(), coarser_if_offline=True)
    assert z.tolist() == [30.0, 30.0]


def test_offline_fallback_still_fails_when_nothing_is_cached():
    class Nothing(dem._BlockStore):
        def get(self, src, level, bx, by):
            raise OfflineError("not cached")

    with pytest.raises(OfflineError):
        dem.sample_latlon(np.array([-89.5]), np.array([10.0]), 5, Nothing(), coarser_if_offline=True)
