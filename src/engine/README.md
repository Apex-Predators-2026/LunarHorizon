# Data Engine

Planned responsibilities:

- Query JPL Horizons for Sun and Earth azimuth/elevation at a lunar surface site and time range
- Load and crop LOLA south-pole elevation tiles
- Compute terrain horizon masks (max obstruction elevation per azimuth)
- Combine ephemeris + horizon mask into sunlight / Earth-visibility timelines

Output format for the rest of the app: see `../../docs/interfaces.md`.
