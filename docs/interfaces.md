# Shared Data Interfaces (draft)

Mirrored in `frontend/src/types.ts` and `backend/app/models.py`. Change all three together.

## Site
```json
{ "id": "shackleton-peak", "name": "Peak Near Shackleton", "lat": 0.0, "lon": 0.0 }
```
Coordinates: degrees, latitude negative = south, longitude east. Real values TBD from NASA's Artemis III candidate region list.

## Timeline step (one per time sample)
```json
{
  "time_utc": "2027-01-01T00:00:00Z",
  "sun":   { "azimuth_deg": 0.0, "elevation_deg": 0.0, "horizon_deg": 0.0, "visible_fraction": 0.0 },
  "earth": { "azimuth_deg": 0.0, "elevation_deg": 0.0, "horizon_deg": 0.0, "visible": false, "margin_deg": 0.0 }
}
```
- `horizon_deg`: terrain horizon elevation at that azimuth
- `visible_fraction`: portion of the solar disk above the terrain horizon (0–1)
- `margin_deg`: Earth elevation minus terrain horizon (negative = blocked)

## Precomputed site file: `data/sites/<id>.json`
Produced by `backend/scripts/precompute.py`. Columnar arrays to keep files small (~1.3 MB for 2 years hourly).
The timeline arrays all have the same length; index `i` across them is one `TimelineStep`.

```jsonc
{
  "site": { "id", "name", "lat", "lon", "source", "x_m", "y_m", "ground_height_m", "observer_height_m" },
  "meta": { "start_utc", "stop_utc", "step", "ephemeris", "terrain": [...] },
  "summary": { "sunlit_pct", "mean_sun_fraction_pct", "earth_visible_pct", "horizon_min_deg", "horizon_max_deg" },
  "horizon": {                       // 720 directions, every 0.5 deg from north, clockwise
    "azimuth_deg": [], "elevation_deg": [], "distance_m": []   // distance_m = how far away the blocking terrain is
  },
  "timeline": {
    "time_utc": [],                  // "2027-01-01T00:00Z", hourly
    "sun_azimuth_deg": [], "sun_elevation_deg": [], "sun_horizon_deg": [], "sun_visible_fraction": [],
    "earth_azimuth_deg": [], "earth_elevation_deg": [], "earth_horizon_deg": [], "earth_margin_deg": [], "earth_visible": []
  }
}
```

Definitions:
- Heights are metres relative to the 1737.4 km reference sphere. `x_m`, `y_m` are Moon Trek south polar stereographic metres.
- `observer_height_m`: sensor height above ground (2 m) used for the horizon.
- Sunlit = `sun_visible_fraction > 0`. Power estimates should use the fraction, not just on/off.
- `earth_visible` = `earth_margin_deg > 0` (Earth's centre above the terrain).

To be agreed by the team.
