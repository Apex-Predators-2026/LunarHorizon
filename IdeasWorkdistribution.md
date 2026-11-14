- Webdev, has to include terrain, date planning, earth and moon position/alignment etc.  
- Most generic idea would be to just have the 3d terrain map and you drop your pin and it tells you the information  
- Next Sunset (when terrain blocks the Sun) and Next Earthset (when Earth dips below the crater rim)  
- Users drag a landing pin across crater rims, ridges, and permanently shadowed regions (PSRs) on a south polar map while live charts update total sunlight hours, solar elevation angle (for solar panel efficiency), and Earth visibility windows in real time.  
- Users select a primary target—such as Artemis III candidate regions like Peak Near Shackleton, Malapert Massif, or Connecting Ridge—and a planned landing date, then shift the schedule by days, weeks, or months. The app immediately compares the original plan against alternative dates and nearby backup sites side-by-side, highlighting how power and direct-to-Earth (DTE) communication windows shift.

What our project will include, BROAD FEATURES: 

1\. \- Data integration for the scientific data

2\. \- Viability and ranking, 3D visualization aspect / simulation of what happens after the landing that will illustrate what would physically happen in real time if that location is chosen; determined by data and algorithm calculations   
\- Comparison with visualizations of what will happen in different circumstances

- Time aspect to account for sun position changes for the rover’s solar panels also accounting for craters and sunlight received in craters.

3\.  UI or UX, dashboard that’s intuitive, lunar site selector, calendar, mission settings, and clear results

4\.  Scientific visualizations, displays sun and earth position above horizon, lighting and communication timelines, and changes over time 

5\. Scenario comparison, comparing multiple sites, landing dates, circumstances, etc.

6\.  Mission rescue and optimization ( automatically find better alternatives when data ie launch is delayed etc ) 

7\.  Validation and explanation system ( verify the calculations against the data, show sources for data, the limitations, and good explanation/representation on how things will pass or fail

SPECIFIC THINGS TO ADD

- Show longest gap for power and longest gap for radio for earth and sun exposure  
- Check sun and Earth angles from JBL at sample time to show difference  
- Show margins of by how much the Earth and sun clears the mission and can show risk assessment of the mission   
- Have sun like a circle so the panels can have % amount of power rather than just on or off  
- Rank mission fails and then tell the next best option depending on what it does  
- Explain why each mission fails and draw a line on the map of which mission fails and why  
-  If the engineering team and the science team have different ideas like the science team might want water or the engineering team might want sunlight+some days of radio and then algo shows the best route where both goals can best be fulfilled. Can also say to loosen some areas if both objectives don’t work together  
-   
  

  Work Distribution  
    
  **1\. Scientific Data Integration & Calculation Engine**

Collect NASA/JPL data, process lunar terrain, calculate Sun/Earth positions and local horizon obstructions. Terrain-aware 3D environment. andrew

**2\. Mission Viability, Risk Assessment & Ranking Algorithm**

Calculate illumination, communication windows, longest outages, safety margins, mission constraint violations, and rank scenarios. andrew

**3\. Interactive User Interface & Mission Configuration  (Nimansh)**

Lunar site selection, date selection, mission duration, lander capabilities, adjustable constraints, and dashboard.

**4\. Scientific Visualization & 3D Mission Simulation**

Realistic Sun/Earth positions, moving shadows, time playback, and analytical charts.

**5\. Multi-Scenario Comparison**

Compare landing sites, dates, mission durations, and spacecraft requirements using synchronized visuals and metrics.

**6\. Mission Rescue & Optimization (Nimansh)**

Automatically search for alternative landing sites or dates when mission requirements change, while explaining recommendations.

**7\. Scientific Validation, Explainability & Uncertainty**

Verify results against reference calculations, display sources, identify limitations, estimate uncertainty where possible, and explain pass/fail decisions.

# 

## **Andrew — Scientific Data Integration & 3D Visualization**

**Original Features 1 \+ 4**

**Responsibility:** Everything related to scientific data, astronomical calculations, and visualizing the lunar environment.

* Integrate NASA/JPL Horizons for Sun and Earth positions.  
* Obtain and process lunar terrain/elevation datasets from LOLA, Moon Trek, and LROC where accessible.  
* Calculate Sun/Earth elevation and azimuth for selected lunar coordinates and times.  
* Calculate local terrain horizons and obstructions caused by craters and mountains.  
* Develop an interactive 3D lunar environment with terrain and a rover/lander model.  
* Visualize Sun and Earth positions relative to the lunar horizon.  
* Simulate sunlight, terrain shadows, and Earth visibility using calculated scientific data.  
* Build sunlight and communication-window timelines and graphs.  
* Implement time sliders, playback, and animations showing how conditions evolve.  
* Ensure the simulation accurately reflects the scientific calculations.  
* Provide standardized scientific and visualization outputs for the rest of the application.

**Final Deliverable:** A scientifically grounded data engine and interactive 3D simulation showing lunar environmental conditions over time.

---

## **Brandon — Mission Viability, Risk Assessment & Ranking Algorithm**

**Original Feature 2**

**Responsibility:** Everything related to determining whether a landing scenario satisfies spacecraft operational requirements.

* Develop the lunar mission viability algorithm.  
* Calculate sunlight availability and Earth-visibility durations.  
* Calculate the longest continuous darkness and communication blackout periods.  
* Evaluate scenarios against spacecraft battery and communication constraints.  
* Calculate Sun/Earth horizon-clearance margins.  
* Assess operational risks and identify constraint violations.  
* Develop a transparent scoring and ranking algorithm.  
* Generate clear explanations for why scenarios pass or fail.  
* Output structured viability results for other components.

**Final Deliverable:** A functional viability, risk assessment, and ranking algorithm.

---

## **Member 3 — Interactive UI/UX & Mission Configuration**

**Original Feature 3**

**Responsibility:** Everything related to the main website, user interaction, and mission configuration.

* Design the website layout and overall user experience.  
* Develop the main mission-planning dashboard.  
* Implement an interactive lunar landing-site selector/map.  
* Add landing date, time, and mission-duration selection.  
* Implement adjustable mission requirements and spacecraft settings.  
* Create clear displays for mission results, viability scores, and risk indicators.  
* Develop navigation, interactive controls, and information panels.  
* Connect the interface to the other components through agreed data interfaces.  
* Polish responsiveness, usability, accessibility, and visual design.

**Final Deliverable:** A polished, intuitive, fully interactive lunar mission-planning website.

---

## **Member 4 — Multi-Scenario Comparison System**

**Original Feature 5**

**Responsibility:** Everything related to comparing different lunar landing scenarios.

* Develop a system for selecting multiple landing scenarios.  
* Implement comparisons between different lunar landing sites.  
* Implement comparisons of different dates at the same location.  
* Compare different mission durations and spacecraft configurations.  
* Compare sunlight availability, Earth visibility, longest outages, and risk margins.  
* Highlight differences, advantages, disadvantages, and trade-offs.  
* Create side-by-side comparison tables and result displays.  
* Implement synchronized scenario comparisons across timelines.  
* Allow users to save, modify, and switch between scenarios.  
* Provide comparison results for the main application.

**Final Deliverable:** A comprehensive comparison system that clearly illustrates differences between lunar landing scenarios.

---

## **Member 5 — Mission Rescue & Optimization**

**Original Feature 6**

**Responsibility:** Everything related to automatically finding better landing options when mission plans change.

* Develop the Mission Rescue system.  
* Allow simulation of launch delays and changing mission requirements.  
* Automatically reevaluate a mission after changes.  
* Implement an algorithm to search for alternative landing locations.  
* Implement a search for alternative landing dates.  
* Use viability results to identify alternatives that satisfy mission requirements.  
* Rank and recommend suitable alternative scenarios.  
* Generate explanations for why each alternative is recommended.  
* Calculate how much an alternative improves critical mission metrics.  
* Implement sensitivity analysis for changes in dates and locations.  
* Provide optimization results for the main application.

**Final Deliverable:** An automated mission recovery and optimization system that identifies and explains better landing alternatives.

---

## **Member 6 — Scientific Validation, Explainability & Uncertainty**

**Original Feature 7**

**Responsibility:** Everything related to verifying scientific accuracy, reliability, and transparency.

* Develop the scientific validation and testing framework.  
* Verify Sun/Earth position calculations against reference JPL Horizons data.  
* Validate terrain obstruction and visibility calculations.  
* Test mission viability algorithms and ranking results.  
* Verify comparison and optimization results.  
* Test edge cases, including continuous darkness, communication blackouts, and unavailable data.  
* Assess scientific uncertainty and limitations of available datasets.  
* Verify consistency between scientific calculations and 3D visualizations.  
* Develop clear explanations of scientific assumptions and results.  
* Document NASA data sources, methodology, and limitations.  
* Ensure recommendations do not overstate scientific certainty.

**Final Deliverable:** A scientifically validated, reliable, and explainable system with documented limitations and accuracy checks.

---

## **Final Team Structure**

| Member | Broad Feature Ownership |
| ----- | ----- |
| **1** | Scientific Data Integration \+ 3D Visualization & Simulation |
| **2** | Mission Viability, Risk Assessment & Ranking |
| **3** | Interactive UI/UX & Mission Configuration |
| **4** | Multi-Scenario Comparison |
| **5** | Mission Rescue & Optimization |
| **6** | Scientific Validation, Explainability & Uncertainty |

Each member owns one defined area of development, with no duplicated feature ownership.

