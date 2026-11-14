from fastapi import FastAPI

from .models import Site
from .rescue.router import router as rescue_router

app = FastAPI(title="Lunar Landing Site Navigator API")
app.include_router(rescue_router)  # Member 5: /api/rescue/*

# Curated sites are filled in once coordinates are taken from NASA's
# Artemis III candidate region list (Plan.txt, Phase 0).
SITES: list[Site] = []


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/sites")
def list_sites() -> list[Site]:
    return SITES
