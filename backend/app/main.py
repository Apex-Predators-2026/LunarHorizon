from fastapi import FastAPI

from .models import Site

app = FastAPI(title="Lunar Landing Site Navigator API")

# Curated sites are filled in once coordinates are taken from NASA's
# Artemis III candidate region list (Plan.txt, Phase 0).
SITES: list[Site] = []


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/sites")
def list_sites() -> list[Site]:
    return SITES
