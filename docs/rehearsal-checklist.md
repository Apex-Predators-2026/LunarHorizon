# Rehearsal with an unfamiliar user (checklist)

[usability-check.md](usability-check.md) is a **simulated** check (personas and estimates). This is for a short
real rehearsal with someone who has not seen the app. Record only what you observe; do not fill in results you did
not see.

## Before (5 min)
- [ ] Production build, offline-capable machine: backend with `LUNAR_OFFLINE=1`, `npm run build && npx vite preview`
      (or the setup you will demo on), screen at 1366×768 or larger. Fresh browser profile (no saved plans).
- [ ] The participant is 18 or older (Space Apps youth privacy rule); ask before recording the screen, never their face.
- [ ] One observer with a timer and the sheet below. Do not explain the app; answer only "what would you try?".

## Tasks (read each aloud, one at a time)
1. "Find out whether the example mission works as planned." (expected: Try a mission → PASS)
2. "The launch slips four days. What happens, and why?" (FAIL; Earth blackout 118 h vs 96 h)
3. "Show me the moment that causes the problem." (Show why → 3D view toward Earth)
4. "Find a way to still do the mission." (Rescue → Malapert Massif passes)
5. "Which plan would you choose, and how sure is the tool?" (Comparison decision; uncertainty line)
6. "Save something you could send to your team." (Summary report → Print / Save as PDF or JSON)
7. Optional: "When else could this site work for a 7-day mission?" (Atlas)

## Record per task
| Task | Completed? (yes / with hint / no) | Time | Where they hesitated or misread | Their words for what the verdict meant |
|---|---|---|---|---|

Also note: did they ever read UNKNOWN as a failure? Did they confuse "Active" with "passes"? Did they find the way
back from the 3D evidence?

## After (3 min)
- [ ] Ask: "What would you tell a teammate this tool does?" Write their answer verbatim.
- [ ] File each problem with the task number and a screenshot; fix the top one or two before the demo.
- [ ] If results are reported anywhere (submission page, slides), report them as what they are: N real participants,
      date, tasks, observed outcomes. Keep them separate from the simulated study.
