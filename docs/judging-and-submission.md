# 2026 NASA Space Apps Challenge: Judging, Awards & Submission Alignment

> **Purpose of this Document:** This file serves as strategic context for developers and AI coding assistants working on the **Lunar Landing Site Navigator** project. Every architectural decision, UI polish item, validation panel, and demo script must optimize for the official **2026 NASA Space Apps Judging Criteria**, **Global Award categories**, and **Project Submission rules**.

---

## 1. Key 2026 Dates & Hard Deadlines

* **Hackathon Dates:** November 14–15, 2026 (2026 Theme: *"The Next Frontier"*)
* **Project Submission Deadline:** **Sunday, November 15, 2026, at 11:59 p.m. local time** of your Local Event (e.g., 11:59 p.m. EST for Ottawa).
  * *Critical Rule:* You must explicitly click **"Submit for Judging"** before 11:59 p.m. Saving a draft is not enough; late submissions are disqualified from Global Judging.
* **Judging Pipeline:**
  1. **Phase 1 — Local Event Judging:** Local judges select **Global Nominees** to advance.
  2. **Phase 2 — Global Finalists & Honorable Mentions (December 2026):** NASA and Space Agency Partner Subject Matter Experts (SMEs) review all Global Nominees.
  3. **Phase 3 — Global Winners (January 2027):** Executive committee of NASA & Space Agency Partner leaders selects the **10 Global Winners**.

---

## 2. Official Judging Criteria (Scored 1–5 Each)

Judges score every project across **five equally weighted pillars**. Below is the official Score-of-5 benchmark and how our codebase directly maximizes each score.

### 1. Impact
* **Official Score-of-5 Benchmark:** Demonstrates exceptional impact by addressing a significant problem with proposed solutions. Reach is extensive, inspiring, benefits a large audience, or could change the world. Quality and effectiveness exceed expectations.
* **How Our Project Wins Here:**
  * Serve **dual audiences** seamlessly: give **mission planners/engineers** quantitative power/DTE telemetry, battery blackout durations, and clearance margins, while giving **educators and the general public** intuitive visual storytelling (3D terrain shadows, Sun/Earth sky paths, and plain-English failure explanations).
  * Frame the tool around real **Artemis III and CLPS** south pole bottlenecks (water ice PSR access vs. extreme grazing sunlight and Earth libration).

### 2. Creativity
* **Official Score-of-5 Benchmark:** Showcases remarkable creativity, introducing a groundbreaking approach that has never been attempted before. Challenges conventional methods, presenting an original and inventive solution that stands out in its field.
* **How Our Project Wins Here (Beyond a Generic "Pin-Drop" Map):**
  * **Mission Rescue & Optimization Engine:** Automatically searches nearby terrain and alternative launch dates when a simulated launch delay or hardware change breaks mission constraints, quantifying metric improvements.
  * **Science vs. Engineering Multi-Objective Resolver:** Resolves conflicting team priorities (e.g., Science wants proximity to a Permanently Shadowed Region for water ice; Engineering wants $\ge 50\%$ DTE comms and continuous solar power) and recommends optimal trade-offs or constraint relaxations.
  * **Fractional Solar Disk Power Modeling:** Models the Sun as an angular disk ($\approx 0.53^\circ$) rather than a binary point source so solar array output reflects partial grazing illumination across crater rims.

### 3. Validity
* **Official Score-of-5 Benchmark:** Scientifically sound and technically feasible, demonstrating strong alignment with established principles. Fully developed and ready for real-world implementation, effectively achieving its intended purpose. Highly usable, user-friendly, and practical for widespread application.
* **How Our Project Wins Here:**
  * **Physics & Terrain Rigor:** Account for lunar curvature ($\text{angle} = \arctan((h_{\text{terrain}} - h_{\text{observer}} - d^2 / 2R) / d)$ where $R = 1737.4\text{ km}$), multi-resolution Moon Trek LOLA DEMs (5 m out to 5 km, 30 m out to 45 km, 200 m out to 300 km), and 720-azimuth horizon masks ($0.5^\circ$ resolution).
  * **Explicit Scientific Validation & Uncertainty UI:** Include a visible **Validation & Methodology** view/panel showing:
    * Cross-checks against JPL Horizons raw ephemerides and LROC `WAC_POLE_ILL_TWI_SOUTH` empirical illumination maps.
    * Alignment with published literature (e.g., Gracy & Lee, LPSC 2024 illumination thresholds for Connecting Ridge and Peak Near Shackleton, plus summit correction at Malapert Massif). **As implemented: Gracy & Lee is the coordinate source for those two sites; the model is not compared against the paper's thresholds. See `docs/submission.md`.**
    * Transparent documentation of model approximations and uncertainty bounds (no atmosphere, straight-map sightlines, Earth center vs. disk margin).
  * **Zero-Crash Reliability:** Precomputed JSON/Parquet datasets for curated Artemis III sites ensure instant, offline-safe responsiveness during judging demos while supporting live `/api/sites/custom` queries ($80^\circ\text{S}$ to $90^\circ\text{S}$).

### 4. Relevance
* **Official Score-of-5 Benchmark:** Thoroughly engages with the challenge, delivering a solution deeply connected to the intended goals. NASA data is integral to the project's success, providing meaningful insights that drive innovation forward.
* **How Our Project Wins Here:**
  * Directly fulfills all 7 challenge objectives: curated & custom site selection, date/schedule shifting, Sun/Earth horizon visualization, power/DTE metrics, 2D + 3D + polar sky visualizations, temporal animations, and cross-skill accessibility.
  * Make **NASA & Space Agency Partner data** unmistakable in both the backend pipeline and frontend attribution:
    * **NASA JPL Horizons System** (via `astroquery`) for high-precision lunar topocentric Sun/Earth azimuth, elevation, and angular diameter.
    * **NASA Moon Trek / LOLA (Lunar Orbiter Laser Altimeter)** GeoTIFF elevation models and PSR layers.
    * **NASA LROC Quickmap** illumination layers (`WAC_POLE_ILL_TWI_SOUTH`) for empirical cross-validation.
    * **Canadian Space Agency (CSA)** Moon Exploration context where applicable.

### 5. Presentation
* **Official Score-of-5 Benchmark:** Well-structured and compelling presentation, clearly articulating the challenge, proposed solution, and importance. Engaging storytelling, polished delivery, and clear organization across both the demo and the Project Submission page.
* **How Our Project Wins Here:**
  * Judges evaluate **both the demo and the full Project Submission page** to compute this score.
  * Ensure UI typography, legends, status badges (Pass / Warning / Fail), and "why it failed" horizon sightlines are self-explanatory even if a judge explores the app or screenshots without live audio narration.

---

## 3. Target Global Awards (10 Categories)

While projects are judged holistically, NASA selects 10 Global Winners across specific award categories. Our architecture is best positioned to compete for:

1. **Best Use of Science:** Best and most valid use of science and/or the scientific method *(Target via curvature-corrected horizon physics, LROC illumination validation, and transparent uncertainty documentation)*.
2. **Best Use of Data:** Best makes space data accessible or leverages it for a unique application *(Target via turning raw JPL Horizons ephemerides + multi-scale LOLA DEMs into instant Mission Rescue & trade-off insights)*.
3. **Best Mission Concept:** Most plausible concept and design *(Target via realistic CLPS/Artemis III engineering constraints: battery dark-time survival, DTE blackout limits, and launch-delay recovery)*.
4. **Best Use of Technology:** Most innovative use of technology *(Target via real-time synchronized 3D terrain shadows, polar horizon sky plots, and automated multi-objective site/date optimization)*.
5. **Galactic Impact / Best Use of Storytelling:** Potential to improve exploration/life and communicate open data clearly to both engineers and educators.

---

## 4. Mandatory Submission & Compliance Checklist

Before clicking **Submit for Judging** on Sunday, November 15 at 11:59 p.m., verify every item below:

### Team & Eligibility Rules
- [ ] **All team members** are registered for the **exact same Local Event** (not waitlisted) and added to the official team roster on the Space Apps website.
- [ ] **Language:** All fields on the Project Submission page, slide deck, and video are in **English**.
- [ ] **Youth Privacy Rule:** No images, video, audio, or likeness of any person under 18 years old appear anywhere in the demo or project materials.
- [ ] **Open Source / Licensing:** All code is in a public repository (e.g., GitHub) with a clear open-source license, and no unlicensed third-party 3D models (such as ripped Quickmap VIPER/Orion meshes) are included.

### Project Submission Page Fields
- [ ] **High-Level Summary:** Clearly states *what* we built, *how* it solves the Lunar Landing Site Navigator challenge, and *why* it matters for Artemis/CLPS and educators.
- [ ] **Detailed Project Description:** Explains core workflows (3D terrain & horizon mask engine, Viability & Risk scoring, Multi-Scenario Comparison, Mission Rescue solver, and Validation suite) plus full tech stack (`React`, `TypeScript`, `Three.js/R3F`, `OpenLayers`, `Zustand`, `FastAPI`, `numpy`, `rasterio`, `astroquery`).
- [ ] **AI / Synthetic Intelligence (SI) Disclosure:** Explicitly identify any AI/LLM-assisted elements used during development, as judges evaluate originality, intent, and execution based on disclosed AI-assisted elements.
- [ ] **NASA Data & References Section (Mandatory for Global Award Eligibility):** Explicitly list and link:
  * NASA JPL Horizons System (`CENTER='coord@301'`)
  * NASA Moon Trek / Lunar Reconnaissance Orbiter LOLA DEMs & PSR layers
  * NASA LROC Quickmap (`WAC_POLE_ILL_TWI_SOUTH`)
  * Gracy & Lee (LPSC 2024), cited as the source of the Connecting Ridge and Peak Near Shackleton coordinates (not as a validation result)

### Demo Format Rules (Choose Slide Deck OR Video)
Judges review **either** a slide deck **or** a video demo (verify exact upload slots on the 2026 submission form):
- [ ] **If Slide Deck:** Maximum **7 slides**, PDF/standard presentation format, English, high-contrast visuals showing real app screenshots (3D terrain shadows, polar sky plot, Mission Rescue recovery, and validation benchmark table).
- [ ] **If Video Demo:** Maximum **30 seconds** (`0:00–0:02` Team intro $\rightarrow$ `0:02–0:05` South pole lighting/comms problem $\rightarrow$ `0:05–0:10` Project name & hook $\rightarrow$ `0:10–0:20` Live UI walkthrough + NASA JPL Horizons/LOLA data $\rightarrow$ `0:20–0:30` Real-world mission & educational impact).

---

## 5. LLM Engineering Directives (How to Use This Context)

When generating code, UI copy, or documentation for this repository, prioritize:
1. **Integration over Net-New Complexity:** Ensure all 6 team modules (Scientific Engine, Viability/Ranking, Dashboard UI, Multi-Scenario Comparison, Mission Rescue, and Validation) share a single synchronized timeline cursor (`useAppStore`) and consistent TypeScript/Pydantic schemas.
2. **Explainability in the UI:** Never show bare numbers without context. Always display *why* a site passes or fails (e.g., *"Blocked by crater rim at azimuth $142.5^\circ$, distance $18.4\text{ km}$"*, battery dark-gap margin, DTE blackout duration).
3. **Attribution & Transparency:** Include a clean footer/modal citing **NASA JPL Horizons**, **NASA Moon Trek / LOLA**, and **LROC Quickmap**, alongside our model assumptions and validation accuracy.
