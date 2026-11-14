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

To be agreed by the team.
