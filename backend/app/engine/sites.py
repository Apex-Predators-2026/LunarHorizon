"""Curated sites. Each entry records where its coordinates came from.

SITES            landing candidates (+ the validation control). Rescue searches these.
REFERENCE_SITES  past landings (Apollo, commercial, other countries), for context and comparison.
                 Kept separate so rescue never proposes "land at Apollo 11" for a polar mission.
ALL_SITES        both; precomputed and listed by the API.

kind: artemis | control | apollo | clps | international
`approximate: True` flags coordinates that are a region estimate rather than a published point.
"""

_ARTEMIS_REGION_ESTIMATE = (
    "Approximate point in NASA's Artemis III candidate region of this name (estimate used by the "
    "rescue catalog, accurate to ~0.1-0.5 deg). Not a published landing point."
)

SITES = [
    {
        "id": "connecting-ridge",
        "name": "Connecting Ridge",
        "kind": "artemis",
        "lat": -89.53432,
        "lon": 209.94767,
        "source": "Gracy & Lee 2024, LPSC 55, abstract 1695 (candidate site in NASA Artemis III region)",
    },
    {
        "id": "peak-near-shackleton",
        "name": "Peak Near Shackleton",
        "kind": "artemis",
        "lat": -89.01701,
        "lon": 126.27302,
        "source": "Gracy & Lee 2024, LPSC 55, abstract 1695 (candidate site in NASA Artemis III region)",
    },
    {
        "id": "malapert-massif",
        "name": "Malapert Massif",
        "kind": "artemis",
        "lat": -85.9635,
        "lon": 357.6326,
        "source": (
            "Local summit (4993 m) found in the Moon Trek 30 m LOLA DEM within 4 km of the commonly quoted "
            "Malapert Mountain point (-85.99, 357.07). That point sits on the flank: a ridge 100 m north "
            "blocks Earth 100% of the time; the summit sees Earth 99.9%."
        ),
    },
    {"id": "de-gerlache-rim", "name": "de Gerlache Rim", "kind": "artemis", "lat": -89.05, "lon": 280.00,
     "approximate": True, "source": _ARTEMIS_REGION_ESTIMATE},
    {"id": "haworth-rim", "name": "Haworth Rim", "kind": "artemis", "lat": -86.60, "lon": 350.00,
     "approximate": True, "source": _ARTEMIS_REGION_ESTIMATE},
    {"id": "nobile-rim-1", "name": "Nobile Rim 1", "kind": "artemis", "lat": -85.40, "lon": 38.00,
     "approximate": True, "source": _ARTEMIS_REGION_ESTIMATE},
    {"id": "mons-mouton", "name": "Mons Mouton", "kind": "artemis", "lat": -84.60, "lon": 31.00,
     "approximate": True, "source": _ARTEMIS_REGION_ESTIMATE},
    {"id": "faustini-rim-a", "name": "Faustini Rim A", "kind": "artemis", "lat": -86.95, "lon": 92.00,
     "approximate": True, "source": _ARTEMIS_REGION_ESTIMATE},
    {
        "id": "shackleton-floor",
        "name": "Shackleton crater floor (control)",
        "kind": "control",
        "lat": -89.67,
        "lon": 129.78,
        "source": "Approximate crater centre. Permanently shadowed: Sun should never be visible. Validation control.",
    },
]

_LROC_2016 = "LROC 'Spacecraft Related Coordinates - 2016 Update' (lroc.im-ldi.com/images/938), lunar module, +/-15 m"

REFERENCE_SITES = [
    {"id": "apollo-11", "name": "Apollo 11", "kind": "apollo", "lat": 0.6742, "lon": 23.4731,
     "source": "LROC NAC, Apollo 11 landing site gallery (lroc.im-ldi.com/visit/exhibits/1/gallery/8)"},
    {"id": "apollo-12", "name": "Apollo 12", "kind": "apollo", "lat": -3.0128, "lon": 336.5781,
     "source": "LRO-image-derived lunar module position, 3.0128 S 23.4219 W (Planet. Space Sci. 2021, Apollo 12 cartography)"},
    {"id": "apollo-14", "name": "Apollo 14", "kind": "apollo", "lat": -3.645, "lon": 342.528,
     "source": "LROC NAC, Apollo 14 landing site gallery (lroc.im-ldi.com/visit/exhibits/1/gallery/6)"},
    {"id": "apollo-15", "name": "Apollo 15", "kind": "apollo", "lat": 26.13239, "lon": 3.63330, "source": _LROC_2016},
    {"id": "apollo-16", "name": "Apollo 16", "kind": "apollo", "lat": -8.9734, "lon": 15.5011, "source": _LROC_2016},
    {"id": "apollo-17", "name": "Apollo 17", "kind": "apollo", "lat": 20.1911, "lon": 30.7723, "source": _LROC_2016},
    {"id": "im-1-odysseus", "name": "IM-1 Odysseus (2024)", "kind": "clps", "lat": -80.13, "lon": 1.44,
     "source": "LROC-located landing site near Malapert A (NASA/LROC, Feb 2024)"},
    {"id": "im-2-athena", "name": "IM-2 Athena (2025)", "kind": "clps", "lat": -84.7906, "lon": 29.1958,
     "approximate": True,
     "source": "Mons Mouton landing site 84 47'26\" S 29 11'45\" E (Wikipedia 'IM-2'); LROC's pre-landing "
               "target was -84.78, 29.13. Sources differ by ~0.1 deg."},
    {"id": "blue-ghost-1", "name": "Blue Ghost Mission 1 (2025)", "kind": "clps", "lat": 18.562, "lon": 61.810,
     "source": "Mare Crisium near Mons Latreille, 18.562 N 61.810 E (Firefly / mission reports)"},
    {"id": "change-3", "name": "Chang'e 3", "kind": "international", "lat": 44.1214, "lon": 340.4883,
     "source": "Mean LRO-derived coordinates (Wagner et al. 2017, 'Coordinates of anthropogenic features on the Moon')"},
    {"id": "change-4", "name": "Chang'e 4 (far side)", "kind": "international", "lat": -45.4561, "lon": 177.5885,
     "source": "LROC topographic map of the Chang'e 4 site (lroc.im-ldi.com/images/1100), +/-3 m"},
    {"id": "change-5", "name": "Chang'e 5", "kind": "international", "lat": 43.06, "lon": 308.08,
     "approximate": True,
     "source": "Commonly quoted 43.06 N 51.92 W in Oceanus Procellarum; not verified against an LROC table."},
    {"id": "change-6", "name": "Chang'e 6 (far side)", "kind": "international", "lat": -41.6385, "lon": 206.0148,
     "source": "41.6385 S 153.9852 W (Wikipedia 'Chang'e 6'); consistent with NASA LRO's ~42 S 206 E"},
    {"id": "chandrayaan-3", "name": "Chandrayaan-3 (Shiv Shakti Point)", "kind": "international",
     "lat": -69.37, "lon": 32.32, "source": "ISRO, Shiv Shakti Point 69.37 S 32.32 E"},
    {"id": "slim", "name": "SLIM (JAXA)", "kind": "international", "lat": -13.3160, "lon": 25.2510,
     "source": "NASA LRO image of the SLIM lander (nasa.gov, 'NASA's LRO Spots Japan's Moon Lander')"},
]

ALL_SITES = SITES + REFERENCE_SITES
