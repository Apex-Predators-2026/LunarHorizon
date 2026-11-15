# Availability check (review item #21)

Checked on 2026-11-15 against the **production build** (`vite build`, served from `dist/`) and a local backend.
The team decided not to host a public copy for now. Every objective below was verified locally instead, so
the same checks can be run unchanged against a hosted copy later: `node scripts/smoke-prod.mjs --url <site>`.

| Objective | Result | Evidence |
|---|---|---|
| Landing page opens | Pass | Production smoke test, step "Open the app: landing page, then the navigator" (fresh browser) |
| Backend is reachable | Pass | The smoke test fails on any 5xx from the API; none occurred |
| Curated mission data loads | Pass | Smoke step "Assess a site: Sun/Earth status, next events and the timeline". Real hourly data for 24 sites, 2026–2031 |
| Flagship workflow completes | Pass | Smoke steps: plan two missions, run one, investigate in 3D, rescue after a launch slip, compare, Feasibility Atlas → Planner |
| Report or export works | Pass | Smoke step "Export the comparison (JSON and CSV files the user can keep)" |
| Restarting keeps the needed data | Pass | Backend stopped and restarted: still 24 sites; Connecting Ridge at 2027-02-08 answers from real data. The site files are in the repo (`data/sites`, 92 MB); caches are on disk |
| Cold start / upstream failure gives a usable state | Partial | Offline check passed: the same journey works with `LUNAR_OFFLINE=1` (cached terrain and precomputed data only; the app says what is unavailable). With the backend fully down, the app doesn't crash and the site panel says "Bad Gateway. Is the backend running on port 8000?", but the 3D view stays on "Loading the Moon…" without saying why |
| Links work without access requests | **Fail** | The landing page's "Source on GitHub" link returns 404 to a logged-out visitor because the repository is private. Make it public (also required for submission), or hide the link until it is |
| Prepared set of real scenarios | Pass | Curated sites plus the verified rescue demo (`backend/app/rescue/demo_scenario.json`) |

Release gate record: `release-gate/LATEST.md` ("Production demo" and "Offline fallback" both PASS on 2026-11-15).

## Still open

1. **Make the GitHub repository public**, or hide the link. This is a team decision, not a code change.
2. **Show a reason in the 3D view when the backend can't be reached**, instead of an endless "Loading the Moon…". This is a small code change for the 3D view's owner.
3. **If hosting is wanted later:** the frontend fits Vercel (static build, with `/api/*` forwarded). The Python
   backend does not fit a Vercel function: its packages are 384 MB against the 250 MB limit, and it needs a disk
   for the terrain cache. Use a Docker host such as Hugging Face Spaces. A ready Space folder (Dockerfile plus
   backend plus `data/sites`) was prepared outside the repo at `~/nasa-space-apps/_hf-space`; nothing was published.
