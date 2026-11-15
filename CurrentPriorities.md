I've reviewed Claude's full product audit. **It changes what I would prioritize before the hackathon submission.**

Your team has built a technically substantial application. The biggest opportunity now is making its existing capabilities faster, more accurate in the interface, and easier for judges to experience.

My recommendation is to **temporarily pause Mission Feasibility Atlas development and address the audit's highest-impact findings first.**

## **1\. What the audit revealed**

**Overall project health**

Strong technical foundation

# **1,969**

Backend tests passed

# **154**

Frontend tests passed

# **24**

Real lunar datasets

These are Claude's reported audit results. The audit tested the backend API but did not visually test the running frontend in a browser.

### **Highest-priority findings**

| Issue | Why it matters | Priority |
| ----- | ----- | ----- |
| Canonical viability explanations are hidden | Judges cannot see the scientific reasoning you've spent so long building | Critical |
| Comparison ranks FAIL scenarios | The UI disagrees with the engine's own ranking contract | Critical |
| Rescue takes 10–13 seconds | Too slow for a smooth demonstration | High |
| Scientific validation isn't displayed | Your strongest evidence for scientific validity is invisible to judges | High |
| README empty, LICENSE missing | Weakens the public submission and raises licensing questions | High |
| No guided demonstration | Judges may not discover the application's most impressive functions | High |

The audit also identified stale dates, potentially misleading Artemis candidate labels and discrepancies between documentation and implementation.

**2\. What your teammates should work on simultaneously**

This is just as important as your own work.

| Owner | Highest-value task |
| ----- | ----- |
| Member 4 - Comparison | Correct FAIL/UNKNOWN rankings and status displays |
| Arush - Rescue | Coordinate performance integration and ensure UNKNOWN sensitivity points display correctly |
| Andrew - Data/3D | Fix stale dates, check Artemis labels, and prepare offline demo terrain data |
| UI owner | Display your viability explanations and create a guided judge-facing workflow |
| Validation member | Make scientific evidence accessible through a methodology/validation panel |
| Whole team | Complete README, licensing, asset provenance and submission materials |

The strongest interaction identified by the audit is **"Show me why."**

For example, a mission fails because it exceeds the allowed continuous darkness. The judge clicks the failed constraint, the application's timeline jumps to that period, and the 3D view illustrates the terrain obstruction responsible.

That would connect your scientific engine directly to Andrew's 3D visualization and the team's mission-planning experience.

Once you've fixed the issues from the audit, **I would shift your team's focus from building more algorithms to making the product exceptionally convincing to judges.**

Your NASA Lunar Landing Site Navigator already has extensive scientific calculations, 3D visualization, mission viability assessment, Rescue, comparison, and validation. At this stage, another 3,000 lines of backend code probably won't help as much as making all of those features work together in one memorable experience.

The five NASA Space Apps judging criteria are **Impact, Creativity, Validity, Relevance, and Presentation**.

spaceappschallenge.org

Here's the order I would recommend.

## **The next five priorities**

**1\. Build one outstanding end-to-end mission demonstration**

Highest priority

Give judges one example mission they can follow from beginning to end: choose a real lunar landing site, inspect the terrain and sunlight, discover an operational problem, and use Mission Rescue to find a better plan.

Every part of the interface should contribute to the same decision, rather than behaving like a separate feature.

**2\. Add one distinctive visual planning feature**

My preferred choice is a small, working **Feasibility Atlas calendar** showing which landing dates are viable for a particular spacecraft.

This is something your existing application doesn't present as clearly, and it directly addresses the challenge's date-flexibility objective.

However, only build it if you can connect it to the interface and test it thoroughly before submission. A polished, working version is more valuable than an extensive unfinished backend.

**3\. Make scientific credibility visible**

Give judges an easy way to see which NASA and JPL datasets support an answer, how the calculations were checked, and what the results cannot establish.

Include a concrete comparison against independent scientific evidence rather than relying on the number of passing software tests.

**4\. Conduct a realistic judging rehearsal**

Ask someone unfamiliar with the project to use it without guidance. Watch whether they understand the mission, the result, and why the recommendation matters.

Fix the problems they actually encounter: confusing labels, loading delays, too many controls, and unclear explanations.

**5\. Produce an excellent submission**

Create a concise video or slide demonstration that communicates the problem, your innovation, and a real result.

The 2026 submission format permits a video no longer than 30 seconds or a presentation of up to seven slides.

GitHub+1

## **What your winning demonstration should look like**

I would make the product tell one scientific story:

Suggested 30-second submission video

[Фото дня. Деталізована мозаїка кратера Шеклтон на Південному полюсі Місяця - Тексти.org.ua](https://images.openai.com/static-rsc-4/lmJ_xDfDCRLAcoScoSDXAmjlh2FeUi1XjKjZe9KrJwMhqB2Y3J3dl8irA2QjVNO-GcVEP4gJE5mKGHd1TKUxx8az-CppkKHs6wIV2FBpBaM7S_NHsQOUAuNPhJDW8omFpEVIOF4DCmyHfrqB8U3VQjqHDuzKzHnHDN8SpSNx-Bo?purpose=inline)

**0–6 seconds - Establish the problem**

“At the Moon's south pole, choosing the wrong landing date can leave a mission without sunlight or direct Earth visibility.”

[The Lunar South Pole Is a Rich Target for NASA's 2024 Moon Goal \| Space](https://images.openai.com/static-rsc-4/AJf-hojcQC21tF1s8I7oevfsfbmv2l-CR1v3ghfBBBH3CjTO9nO5W_mzgjFQsR3G5Je1cfbdo_m9jWx37oEcuUPfd8QnLD68g3LHwXBxwoVWNrP8g0djFvwrpCx40zK6-asonrbCExlR1nSS5xcxV32zvRqM-Mcyzdk87g97-cw?purpose=inline)

**6–14 seconds - Demonstrate the science**

Show the 3D terrain, changing shadows, timeline, and the specific constraint that makes a tested mission fail.

[Lunar Orbiter Captures Stunning View of Possible Artemis 3 Landing Site](https://images.openai.com/static-rsc-4/ZXn9w7ncO6pF54xg8WZ94PyTT7c7P27Wf4oO2r8Fpdrp0aI1rq_LPb9SStpRE4X2IRTt3x-KV_EnRBgKDZoDpbSGQ_fgc7v6tyCoVp50gWre9eTojwh_-WSraC_Zu2hRWDjKqJ1xTxYgu_JQYALjtVrKBycCM-a2jJyjR0kutj4?purpose=inline)

**14–24 seconds - Show the innovation**

Use Rescue to compare an alternative landing opportunity and explain why it satisfies the spacecraft's requirements.

**24–30 seconds - Establish credibility and value**

Show the NASA/JPL data attribution and validation evidence, and finish with the tool's ability to support faster, clearer mission trade-off decisions.

Use actual screen recordings and verified results in the final submission, not the illustrative images above.

This would demonstrate the project's scientific relevance, novelty and functionality in a very short time.

## **How I'd divide the remaining work**

| Team responsibility | Focus |
| ----- | ----- |
| You - Member 2 | Viability API, Rescue performance, evidence-backed results, and potentially a minimal Atlas calendar |
| Arush - Rescue | Make the failure-to-recovery workflow convincing and reliable |
| Member 4 - Comparison | Accurate rankings and visually clear trade-offs |
| UI/visualization owners | Guided demonstration, timeline synchronization and polished interactions |
| Data/validation owners | Scientific evidence, correct source attribution and limitations |
| Team lead/submission owner | Video, submission materials, README, public deployment and deadline |

## **The deadline changes the strategy**

NASA confirms that the official submission closes **Sunday, November 15, 2026, at 11:59 PM local time**.

spaceappschallenge.org

I would aim to have the demonstration and submission materials ready several hours before that deadline, with the final stretch reserved for verification and uploading.

Make sure the final application and video links are accessible without special permissions, and include the NASA data references and AI-tool disclosures required by the submission process.

GitHub+1

## **What I'd stop doing**

I would not start another large algorithmic phase unless it directly improves what judges can experience. In particular, I would defer Atlas's advanced refinement, multiple capability studies and optional sensitivity features if they threaten the stability of the current product.

**My single highest-return recommendation:** Create a **one-click “Explore a Mission” experience** that loads a real, prevalidated scenario, shows the failure or trade-off visually, launches Rescue, and lets the judge inspect the scientific explanation.

That would connect your team's strongest work into one coherent experience.

You already have much of the underlying functionality. Making it easy for a judge to experience that functionality may be the single biggest improvement you can make before submission.

**2\. Exact assignments for each team member**

**You - Member 2: Viability, scientific reasoning and performance**

Your existing post-audit assignment remains the right starting point.

1. Finish `/api/viability/assess` and the validation-summary endpoint.  
2. Optimize Rescue's repeated conversion of scientific time-series data.  
3. Deliver exact ranking and uncertainty contracts to Member 4\.  
4. Help the UI owner connect a failed constraint to its corresponding time window in the 3D viewer.

**Definition of done:** A judge can select a mission, get the canonical verdict, read its reasons, and inspect the exact time where a requirement fails. Rescue must preserve its scientific results after optimization.

Once that's complete, your next worthwhile feature is a **small Atlas heatmap**, not the entire multi-phase Atlas plan.

**Arush - Mission Rescue and recovery workflow**

1. Coordinate the performance improvement with you.  
2. Correct UNKNOWN displays in Rescue sensitivity views.  
3. Make the recovery workflow intuitive: original mission → disruption → failure reason → alternatives → revised plan.  
4. Clearly communicate whether an alternative actually passes the requirements, and whether its result depends on uncertain data.

**Definition of done:** A judge can simulate a launch delay and find a scientifically justified alternative without navigating through multiple disconnected pages.

This is your team's most promising differentiator against the competitors reviewed.

**Andrew - Scientific data, 3D terrain and factual accuracy**

1. Verify Artemis landing-region labels and correct outdated or misleading names.  
2. Correct inconsistent date-range descriptions and ensure displayed coverage reflects the actual data.  
3. Prefetch or bundle all terrain needed for the demonstration; test shadow playback and blocked-horizon visuals.  
4. Ensure visualizations agree with the data used by the viability engine.

**Definition of done:** The demo renders without unexpected scientific-data downloads, and the Sun, Earth, horizon, dates and site labels are scientifically consistent.

Don't replace existing site data with new coordinates immediately before submission unless the team can regenerate and validate all affected outputs.

**Member 4 - Comparison and decision-making interface**

1. Fix the comparison ranking bug: only eligible PASS scenarios receive canonical ranks.  
2. Show UNKNOWN as unknown, not failed; do not convert missing scores into zero.  
3. Explain trade-offs in plain language: which option is better, on what evidence, under which mission requirements?  
4. If time remains, add a lightweight CSV/JSON export or shareable scenario link.

**Definition of done:** A user can compare two mission plans without mistaking an ineligible or uncertain result for a recommended option.

The export/share feature is competitive parity, not a prerequisite.

**UI / frontend owner - Presentation and guided experience**

1. Add a **Try a Mission** entry point that loads a known, tested scenario.  
2. Show the viability assessment in an understandable panel.  
3. Add a **Show why** action that jumps the timeline to the relevant scientific evidence.  
4. Build a compact guided flow through the 3D view, analysis, Rescue and comparison.  
5. Include visible loading, error and recovery states.

**Definition of done:** Someone who has never seen the application understands its central purpose within 30 seconds.

The competitor report specifically indicates that several rival applications already have guided tours. Your tour should be more useful than a sequence of tooltips: it should demonstrate a meaningful mission-planning decision.

**Validation / submission owner - Evidence, credibility and submission**

1. Build or supply content for the Validation & Methodology panel using your existing scientific reports.  
2. Check that every numerical accuracy claim is backed by the correct experiment.  
3. Complete README, NASA data citations, AI-use disclosure, asset attribution and licensing review.  
4. Coordinate the demo video/slides, project description and final submission.

**Definition of done:** Judges can independently understand the data sources, methods, limitations and actual contribution of the project.

Do not simply apply an MIT license to third-party assets without checking their rights. The rover model identified in the audit needs an attribution or permission review.

Assign **one team integrator** as well, even if that person also owns another area. Only that person should coordinate final merges, production deployment and release verification. Everyone else should work in clearly separated files or branches, avoiding repeated changes to shared entry points.

## **3\. Make the product's main experience unforgettable**

The most compelling addition isn't a new scientific model. It's connecting the science, visuals and Rescue functionality.

The ideal judge-facing workflow

1. **Select a real landing mission.**  
   Automatically load a tested lunar site, date, mission duration and spacecraft constraints.  
2. **See the environment.**  
   Display 3D terrain, sunlight, Earth visibility and the mission timeline.  
3. **Introduce a launch delay.**  
   Show how the new date changes the lighting or communications conditions.  
4. **Explain the failure.**  
   Display the violated requirement and jump to the moment it breaks, with visible terrain evidence.  
5. **Rescue the mission.**  
   Recommend a new site/date or an explicitly labeled engineering compromise.  
6. **Prove the result.**  
   Compare the original and revised plans and show the NASA data source, assumptions and validation evidence.

Your audit already proposed a promising Malapert Massif delayed-launch example. Use that if the final integration reproduces its reported results. Otherwise, choose another stable, verified case. Do not hardcode an impressive outcome that the live model doesn't support.

## **4\. Which competitor features should we copy, improve or skip?**

The report is most useful as a prioritization tool, not as a feature shopping list.

| Competitor advantage | Team decision | Reason |
| ----- | ----- | ----- |
| Guided tour / mission story | **Build** | High presentation value, mostly existing functionality |
| In-app validation | **Build** | High scientific credibility, API evidence already exists |
| Public deployment | **Build** | Essential for accessibility and independent inspection |
| Dates heatmap | **Build if time** | High relevance, Atlas groundwork exists |
| Export / share links | Optional | Useful and relatively contained |
| Earth-disk grazing warning | Optional, clearly scoped | Could improve scientific nuance without claiming new comms modeling |
| DSN ground-station windows | Defer | Adds a new layer of communications modeling |
| Battery power simulation in watts/kWh | Defer | Needs spacecraft, array and efficiency assumptions |
| Monte Carlo landing-error simulation | Defer | High implementation and validation cost |
| New published-paper comparisons | Only if carefully verified | Credible existing validation beats a rushed extra experiment |
| Mast-height optimization | Defer | New physical modeling and data dependencies |

