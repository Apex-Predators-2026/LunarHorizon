# Shared Data Interfaces (draft)

Proposed per-timestep output from the data engine, consumed by viability, UI, comparison and viz:

```json
{
  "site": { "name": "Peak Near Shackleton", "lat": -89.45, "lon": 222.69 },
  "time_utc": "2027-01-01T00:00:00Z",
  "sun":   { "azimuth_deg": 0.0, "elevation_deg": 0.0, "horizon_deg": 0.0, "visible_fraction": 0.0 },
  "earth": { "azimuth_deg": 0.0, "elevation_deg": 0.0, "horizon_deg": 0.0, "visible": false }
}
```

- `horizon_deg`: terrain horizon elevation at that azimuth
- `visible_fraction`: portion of the solar disk above the terrain horizon (0–1)

To be agreed by the team.
