"""Defensive HTTP security helpers: response headers and sliding-window per-IP rate limiting."""
from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque

from fastapi import Request, Response
from fastapi.responses import JSONResponse

SECURITY_HEADERS: dict[str, str] = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}

# (HTTP method, path): (bucket name, env var override, default requests per 60s window)
RATE_LIMITED_ROUTES: dict[tuple[str, str], tuple[str, str, int]] = {
    ("POST", "/api/assistant/chat"): ("chat", "RATE_LIMIT_CHAT_PER_MIN", 30),
    ("POST", "/api/sites/custom"): ("custom_site", "RATE_LIMIT_CUSTOM_SITE_PER_MIN", 20),
    ("POST", "/api/rescue"): ("rescue", "RATE_LIMIT_RESCUE_PER_MIN", 60),
}

_WINDOW_SECONDS = 60.0
_lock = threading.Lock()
_hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)


def reset_rate_limiters() -> None:
    """Clear recorded request timestamps (used by automated tests)."""
    with _lock:
        _hits.clear()


def client_ip(request: Request) -> str:
    """Resolve caller IP without trusting spoofable forwarding headers unless explicitly enabled."""
    trust_proxy = os.environ.get("TRUST_PROXY_HEADERS", "").strip().lower() in ("1", "true", "yes")
    if trust_proxy:
        cf_ip = request.headers.get("cf-connecting-ip", "").strip()
        if cf_ip:
            return cf_ip
        xff = request.headers.get("x-forwarded-for", "")
        if xff:
            first = xff.split(",")[0].strip()
            if first:
                return first
    return request.client.host if request.client else "unknown"


def _limit_for(env_var: str, default: int) -> int:
    raw = os.environ.get(env_var, "").strip()
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


def check_rate_limit(request: Request) -> JSONResponse | None:
    """Return a 429 response when a protected endpoint exceeds its per-IP minute budget."""
    rule = RATE_LIMITED_ROUTES.get((request.method.upper(), request.url.path))
    if rule is None:
        return None
    bucket, env_var, default_limit = rule
    limit = _limit_for(env_var, default_limit)
    key = (bucket, client_ip(request))
    now = time.monotonic()
    cutoff = now - _WINDOW_SECONDS

    with _lock:
        q = _hits[key]
        while q and q[0] <= cutoff:
            q.popleft()
        if len(q) >= limit:
            retry_after = max(1, int(q[0] + _WINDOW_SECONDS - now) + 1)
            resp = JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded. Please wait before trying again."},
                headers={"Retry-After": str(retry_after)},
            )
            apply_security_headers(request, resp)
            return resp
        q.append(now)
    return None


def apply_security_headers(request: Request, response: Response) -> Response:
    """Attach baseline hardening headers (and HSTS when served over HTTPS)."""
    for name, value in SECURITY_HEADERS.items():
        # Preserve docs UI functionality if accessed directly while locking down API responses.
        if name == "Content-Security-Policy" and request.url.path in ("/docs", "/redoc", "/openapi.json"):
            continue
        response.headers.setdefault(name, value)
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    if request.url.scheme == "https" or proto == "https":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response
