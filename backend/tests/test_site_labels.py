"""Artemis III region labels (engine/sites.py `artemis_list`) and how /api/sites reports them."""

from fastapi.testclient import TestClient

from app.engine.sites import ALL_SITES
from app.main import app

client = TestClient(app)

# NASA's October 2024 update (still the list in NASA's LPSC 2026 abstract): the 9 Artemis III regions.
NASA_2024 = {
    "Peak near Cabeus B", "Haworth", "Malapert Massif", "Mons Mouton Plateau", "Mons Mouton",
    "Nobile Rim 1", "Nobile Rim 2", "de Gerlache Rim 2", "Slater Plain",
}
# The original 13 (August 2022).
NASA_2022 = {
    "Faustini Rim A", "Peak Near Shackleton", "Connecting Ridge", "Connecting Ridge Extension", "de Gerlache Rim 1",
    "de Gerlache Rim 2", "de Gerlache-Kocher Massif", "Haworth", "Malapert Massif", "Leibnitz Beta Plateau",
    "Nobile Rim 1", "Nobile Rim 2", "Amundsen Rim",
}
# Our site -> the NASA region it sits in (None: not determinable, see sites.py).
REGION = {
    "connecting-ridge": "Connecting Ridge", "peak-near-shackleton": "Peak Near Shackleton",
    "malapert-massif": "Malapert Massif", "haworth-rim": "Haworth", "nobile-rim-1": "Nobile Rim 1",
    "mons-mouton": "Mons Mouton", "faustini-rim-a": "Faustini Rim A", "de-gerlache-rim": None,
}


def test_every_artemis_site_says_which_nasa_list_names_it():
    artemis = [s for s in ALL_SITES if s["kind"] == "artemis"]
    assert {s["id"] for s in artemis} == set(REGION)
    for s in artemis:
        region = REGION[s["id"]]
        if region is None:
            assert s["artemis_list"] == "unconfirmed"
        elif region in NASA_2024:
            assert s["artemis_list"] == "2024", s["id"]
        else:
            assert region in NASA_2022 and s["artemis_list"] == "2022", s["id"]
    assert all("artemis_list" not in s for s in ALL_SITES if s["kind"] != "artemis")


def test_api_reports_the_list_without_touching_names_or_coordinates():
    sites = {s["id"]: s for s in client.get("/api/sites").json()}
    assert sites["malapert-massif"]["artemis_list"] == "2024"
    assert sites["connecting-ridge"]["artemis_list"] == "2022"
    assert sites["de-gerlache-rim"]["artemis_list"] == "unconfirmed"
    assert sites["apollo-11"]["artemis_list"] is None
    cr = sites["connecting-ridge"]
    assert (cr["name"], cr["kind"], cr["lat"], cr["lon"]) == ("Connecting Ridge", "artemis", -89.53432, 209.94767)
