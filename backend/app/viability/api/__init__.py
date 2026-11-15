"""HTTP API of the canonical viability engine (Member 2): ``/api/viability/assess`` and
``/api/viability/validation-summary``. Kept out of ``app.viability`` itself so the core package stays free of
FastAPI. See docs/viability-api.md.
"""

from .router import router

__all__ = ["router"]
