# Backend (Python + FastAPI)

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate            # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
pytest                            # tests
uvicorn app.main:app --reload     # http://127.0.0.1:8000  (interactive docs at /docs)
```

## Layout

```
app/
  main.py        FastAPI app; each member registers their router here
  models.py      Shared models (mirrors docs/interfaces.md and frontend/src/types.ts)
  engine/        Data engine (Andrew): Horizons, Moon Trek terrain, horizon masks, timelines
  rescue/        Mission Rescue & Optimization (Member 5); see docs/rescue.md
    timeline/    Timeline provider: reads data/sites/ timelines, synthetic fallback
    viability/   Placeholder viability checker until Brandon's is ready
scripts/         One-off checks (phase1_check.py)
tests/           pytest suite
```
