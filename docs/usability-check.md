# Quick usability check (review item #20)

This is a short, honest usability check with a few people who have never seen the app. It is **not** a
controlled study. Report only what actually happened, with the sample size. Never extrapolate to claims
like "90% faster planning".

**Time:** about 10 minutes per person. Run 3 to 5 people, ideally a mix such as a student, a teacher,
and an engineer or STEM person.

**Privacy (Space Apps rules):** don't record the face or voice of anyone under 18. Taking notes is fine.
A screen recording with no face or voice is fine with the person's consent. Don't put names in the
results; use P1, P2 and so on.

## Setup (before each person)

1. Start the app with the backend (`uvicorn` on :8000) and the frontend (`vite` on :5173). Open
   http://localhost:5173 in a fresh browser window.
2. Click **Open the navigator**. In the Plans panel, create the demo plan:
   **Connecting Ridge, landing 2027-02-08 00:00 UTC, 7 days, default requirements** (the file writes them out).
   This is the verified demo case in `backend/app/rescue/demo_scenario.json`. It passes as planned and
   fails after a 5-day delay, and rescue finds passing alternatives.
3. Put the rescue panel back to its defaults (launch delay 0, Explain off).
4. Don't explain the app. Say only: "This tool helps plan lunar landings. Please think out loud. I can't
   help unless you're stuck."

## The four tasks

Read each task aloud. Start a timer when you finish reading and stop it when the person gives the answer.
If someone is stuck for 2 minutes, give one hint and mark the task **assisted**.

| # | Say this | Counts as success when the person… |
|---|---|---|
| 1 | "Here is a planned landing. Does this mission meet its requirements? How can you tell?" | says it passes and points to where the app shows that (the verdict or score) |
| 2 | "The launch slips by 5 days. Does the mission still work? If not, what is the main problem?" | enters the delay, says it fails, and names the limiting requirement: the longest power gap / battery limit (about 63 h, where the limit is 50 h) |
| 3 | "Find a landing that works after the delay." | runs Find alternatives and picks a passing option (any of the recommended ones) |
| 4 | "Why is that option acceptable?" | gives a reason the app shows: it passes the requirements, what it fixes, its headroom, or the Explain walkthrough |

After each task, ask: **"How easy was that, from 1 (very hard) to 7 (very easy)?"** This is the
Single Ease Question (SEQ).

## What to write down

Fill in one row per person per task in `docs/usability-results.csv`. Copy it from
`docs/usability-results-template.csv`.

- `completed`: `yes`, `assisted` or `no`
- `time_s`: seconds, from the end of the instruction to the answer
- `seq`: 1 to 7
- `confusion`: what they hesitated on or misread, in their own words if possible
- `quote`: one short quote, optional

## After the sessions

1. Count the results per task: completed / assisted / failed, the median time, and the median SEQ.
2. List the confusion points and group the ones that repeat. The top 2 or 3 are what to fix.
3. Fix the quickest of them if there's time. Then try it with one more person to confirm the fix.

## How to report it (submission page, slides)

Use the real numbers only, and include the sample size and what kind of check it was. For example, with
your own numbers:

> In an informal check, N people who had never used the app tried four tasks. X of N decided correctly
> whether the plan met its requirements, Y of N identified the limiting requirement after a 5-day delay,
> and Z of N found and justified a working alternative. The median time to find the alternative was M s.
> The most common confusion was "…", which we then fixed by "…".

Don't call it a study, don't add percentages for fewer than 10 people, and don't compare it with tools
you didn't test.

## Results (simulated run)

> **Simulated, not real participants.** The four people below are imaginary personas played by the team's
> AI assistant on 2026-11-14, against the real running app (the demo plan above, 1440×900 browser). Their
> reactions are based on what the interface actually showed at each step. Times and ease ratings are
> estimates. Use this to find problems to fix. Do **not** quote it as user evidence on the submission page.

**Participants (personas):**
- **P1:** high-school student interested in space.
- **P2:** middle-school science teacher.
- **P3:** aerospace engineering undergraduate.
- **P4:** parent with no space background.

### Per person

| Participant | Task | Completed | Time (s) | Ease (1–7) | What happened |
|---|---|---|---|---|---|
| P1 | 1 | assisted | 150 | 3 | Pressed Run, then looked for a pass/fail. Saw "longest dark 4.5 d" on the timeline and guessed it fails. Needed the hint that the verdict shows in rescue or comparison. |
| P1 | 2 | yes | 70 | 5 | Read "Longest power gap (battery limit) 63 h (allows at most 50 h)" in the rescue summary. |
| P1 | 3 | yes | 30 | 6 | Picked #1 Malapert Massif straight from the card list. |
| P1 | 4 | yes | 60 | 6 | Used "passes all requirements" and the headroom line. |
| P2 | 1 | no | 180 | 2 | Said "it fails, it's dark for 4.5 days". The timeline stats cover the 14-day view window, including days before landing, not the mission. |
| P2 | 2 | yes | 85 | 5 | Found the delay field and read the failing rule. "Battery limit, OK, that makes sense." |
| P2 | 3 | yes | 45 | 5 | Paused on "976 more options skipped: no real data there". "Is something broken?" |
| P2 | 4 | yes | 75 | 6 | Turned on Explain. "This walkthrough is what I'd show a class." |
| P3 | 1 | yes | 95 | 4 | Opened Scenario Comparison to find a verdict. "The planner should just say pass or fail." |
| P3 | 2 | yes | 40 | 6 | Identified the 63 h vs 50 h power gap at once. |
| P3 | 3 | yes | 25 | 6 | Chose #1. Asked whether moving 134.6 km to another site is a realistic rescue. |
| P3 | 4 | yes | 40 | 6 | Pointed out that all three alternatives show the same headroom line, so it doesn't help choose between them. |
| P4 | 1 | assisted | 160 | 3 | The tour prompt covered part of the view; dismissed it unread. Then the same timeline confusion as P2. |
| P4 | 2 | assisted | 120 | 4 | Didn't see the launch-delay field; the rescue panel needed scrolling. Hint: "look under Mission rescue". |
| P4 | 3 | yes | 50 | 5 | Also unsure what "skipped: no real data" means. |
| P4 | 4 | assisted | 110 | 4 | Didn't know the word "headroom". After the hint, explained the option using "passes all requirements". |

### Summary

| Task | Completed | Assisted | Not completed | Median time | Median ease |
|---|---|---|---|---|---|
| 1. Does it meet requirements? | 1 | 2 | 1 | 155 s | 3 |
| 2. What breaks after a 5-day delay? | 3 | 1 | 0 | 78 s | 5 |
| 3. Find a working alternative | 4 | 0 | 0 | 38 s | 5.5 |
| 4. Why is it acceptable? | 3 | 1 | 0 | 68 s | 6 |

Participants: N = 4 (simulated personas) · Date: 2026-11-14 · Run by: team AI assistant, against the real app

### Top confusion points and suggested fixes

1. **No verdict in the planner after Run (3 of 4).** The plan card only says "Running". The timeline's
   "longest dark 4.5 d · blackout 10.5 d" covers the 14-day view window, including days before landing,
   so it looks like a failure for a plan that actually passes (score 100).
   *Fix:* show the plan's pass/fail and score on the plan card after Run, and label the timeline stats
   "in this 14-day view" or limit them to the mission. Owners: plans/UI (Bryan) and timeline (Andrew).
2. **"976 more options skipped: no real data there" reads like an error (2 of 4).**
   *Fix (rescue):* reword as "Also skipped 976 nearby points we have no terrain data for (not
   errors)", or show it only in Explain mode.
3. **"Headroom" is jargon, and the same headroom line on every card doesn't help choose (2 of 4).**
   *Fix (rescue):* add "headroom" to the Explain glossary, and on each card name what differs, e.g. the
   date shift, the distance moved or the closest limit.
4. **The launch-delay field sits below the fold of the rescue panel (1 of 4).**
   *Fix (rescue):* put the delay field and Find alternatives at the top of the panel.
5. **The guided-tour prompt covers the view on arrival (1 of 4).** Owner: tutorial.

Tasks 2–4, the rescue flow, went smoothly once people found the rescue panel: 10 of 12 attempts were
completed without help. Task 1, the plan verdict outside rescue, is where people struggled most.
