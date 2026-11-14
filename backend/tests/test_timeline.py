import json
from datetime import datetime, timezone

import numpy as np
import pytest

from app.models import TimelineStep
from app.rescue.catalog import SITES, custom_site, get_site
from app.rescue.timeline import PrecomputedTimelineProvider, SyntheticTimelineProvider, solar_disk_fraction

T0 = datetime(2027, 1, 1, tzinfo=timezone.utc)
T1 = datetime(2027, 1, 3, tzinfo=timezone.utc)


def test_solar_disk_fraction_edges():
    assert solar_disk_fraction(np.array([5.0]), np.array([0.0]))[0] == pytest.approx(1.0)
    assert solar_disk_fraction(np.array([-5.0]), np.array([0.0]))[0] == pytest.approx(0.0)
    assert solar_disk_fraction(np.array([1.0]), np.array([1.0]))[0] == pytest.approx(0.5)


def test_solar_disk_fraction_is_monotonic():
    el = np.linspace(-1, 1, 50)
    f = solar_disk_fraction(el, np.zeros_like(el))
    assert np.all(np.diff(f) >= -1e-12)


def test_synthetic_timeline_shape_and_ranges():
    tl = SyntheticTimelineProvider().timeline(get_site("malapert-massif").to_site(), T0, T1, 1.0)
    assert len(tl) == 49  # inclusive of both ends
    assert tl.source == "synthetic-placeholder"
    for arr in (tl.sun_az, tl.earth_az):
        assert np.all((arr >= 0) & (arr < 360))
    # South-polar sites never see the Sun or Earth high in the sky.
    assert np.abs(tl.sun_el).max() < 10
    assert np.abs(tl.earth_el).max() < 15
    assert np.all((tl.sun_visible_fraction >= 0) & (tl.sun_visible_fraction <= 1))


def test_synthetic_sites_have_a_mix_of_conditions():
    p = SyntheticTimelineProvider()
    fracs = []
    for s in SITES:
        tl = p.timeline(s.to_site(), T0, datetime(2028, 1, 1, tzinfo=timezone.utc), 6.0)
        fracs.append((tl.sun_visible_fraction >= 0.25).mean())
    # Over a full year every site has some night, and none is permanently dark.
    assert all(0.2 < f < 0.98 for f in fracs), fracs


def test_precomputed_roundtrip_and_fallback(tmp_path):
    site = get_site("connecting-ridge").to_site()
    synth = SyntheticTimelineProvider()
    tl = synth.timeline(site, T0, T1, 1.0)
    steps = tl.to_steps()
    # Every step must validate against the team's TimelineStep model.
    for s in steps:
        TimelineStep.model_validate(s)
    # Mark the data so we can tell which provider answered.
    for s in steps:
        s["sun"]["visible_fraction"] = 0.123
    (tmp_path / "connecting-ridge").mkdir()
    (tmp_path / "connecting-ridge" / "timeline.json").write_text(json.dumps({"timeline": steps}), encoding="utf-8")
    p = PrecomputedTimelineProvider(fallback=synth, data_dir=tmp_path)

    got = p.timeline(site, T0, datetime(2027, 1, 2, tzinfo=timezone.utc), 1.0)
    assert got.source == "precomputed:connecting-ridge/timeline.json"
    assert len(got) == 25 and np.allclose(got.sun_visible_fraction, 0.123)

    # Outside the file's range -> synthetic fallback.
    later = p.timeline(site, datetime(2027, 2, 1, tzinfo=timezone.utc), datetime(2027, 2, 2, tzinfo=timezone.utc), 1.0)
    assert later.source == "synthetic-placeholder"
    # Custom coordinates -> synthetic fallback.
    custom = custom_site("near the ridge", site.lat, site.lon)
    assert p.timeline(custom, T0, T1, 1.0).source == "synthetic-placeholder"


def test_precomputed_bare_list_file(tmp_path):
    site = get_site("malapert-massif").to_site()
    steps = SyntheticTimelineProvider().timeline(site, T0, T1, 1.0).to_steps()
    (tmp_path / "malapert-massif.json").write_text(json.dumps(steps), encoding="utf-8")
    got = PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider(), data_dir=tmp_path).timeline(site, T0, T1, 1.0)
    assert got.source == "precomputed:malapert-massif.json"
    assert len(got) == len(steps)


def test_precomputed_rejects_uneven_steps(tmp_path):
    site = get_site("malapert-massif").to_site()
    steps = SyntheticTimelineProvider().timeline(site, T0, T1, 1.0).to_steps()
    del steps[5]
    (tmp_path / "malapert-massif.json").write_text(json.dumps(steps), encoding="utf-8")
    with pytest.raises(ValueError, match="evenly spaced"):
        PrecomputedTimelineProvider(fallback=SyntheticTimelineProvider(), data_dir=tmp_path).timeline(site, T0, T1, 1.0)
