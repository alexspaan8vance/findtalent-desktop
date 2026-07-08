# 8vance match-app "Preferences" — capability map + what findtalent can replicate

Captured live via Playwright on `match.8vance.com` (job 673814578, Blue Circle
Company 33060), 2026-06-23. The match app does NOT use the public v1 API — it
talks to an internal service `tm-scout-router.8vance.com`.

## The internal engine (tm-scout-router)

Talent-Match tab fires:

- `GET /search-filters/?target_id=<job-UUID>` → the stored filter+preference object
- `GET /search-status/<search_id>/`
- `POST /results/?target_id=<job-UUID>&search_id=<id>&page_size=50&sort_criteria=best_matches&category=talent&vector_matching=true&soft_matching=false`
  body: `{"custom_matching_weights": {"1":0,"2":0,"3":0,"4":0,"7":0}}`
- `GET /radar-sectors/`

### Preferences dialog = 5 weight sliders
"Which parts of the profile do you consider most important? Give it a boost!"

| Slider (UI label) | weight key |
|---|---|
| Soft & transferable skills | (one of 1–7) |
| Skills, competences and knowledge fields | |
| Work Experience | |
| Education | |
| Ambition | |

- 5 sliders map onto `custom_matching_weights` keys `{1,2,3,4,7}`. Exact label↔key
  needs one-slider-at-a-time probing — observed: moving "Soft & transferable" hit
  key 2, "Education" hit key 7 (NOT visual order).
- **Weight transform:** `weight = sliderValue/100 - 1`, range **[-1, 0]**.
  Slider 100 = weight 0 (full weight / neutral); slider 0 = weight -1 (fully
  de-prioritise). "Save and update" re-runs the search server-side.

### Filters dialog (the `search-filters` payload)
```
sources: string[]                       // source slugs (same concept as public API)
keywords: { include: [], exclude: [] }
location: { lat, lng, radius, radius_unit }
smart_filters: { skills:[], operator: "AND"|"OR", educations:[], industries:[], experiences:[] }
source_groups: []
enable_2d_taxonomy: bool
unknown_experience: bool
education_levels_range: { start, end }
unknown_education_levels: bool
years_of_experience_range: { start, end }
custom_matching_weights: { "1":0, "2":0, "3":0, "4":0, "7":0 }
```

### Results payload (per talent)
```
results[].location: "lat,lng"           // RAW coords (PII — never expose)
results[].extra: { object_id (= talent_id), category, created_at, updated_at, last_active, ... }
results[].matching_objects[<job-uuid>].matching:
    score: 0..1
    vector_score: [[dim, score], ...]   // dims 1..9 + 888 + 999 (more than the 5 sliders)
    quality:      [[dim, 0..1], ...]
results[].matching_objects[<job-uuid>].function_radar: { angle, function_type_id, top_field_of_work_id }
```
The per-dimension `vector_score` + `function_radar.angle` is what powers 8vance's
native match-radar. Weights re-score server-side (verified: a talent's score
went 0→1.0 after re-weighting).

## What findtalent CAN and CANNOT do via the PUBLIC v1 API

Our client + token use public v1 only. `POST /match/talent/?job_id=` accepts
**only** a `sources` body — see `docs/8vance-api-prod.md`.

| Capability | match-app (scout-router) | findtalent (public v1) |
|---|---|---|
| Per-dimension preference WEIGHTS | `custom_matching_weights` → server re-match | ❌ not in public API |
| soft/vector matching toggle | `soft_matching` / `vector_matching` query params | ❌ |
| Server-side FILTERS (radius, ranges, keywords, AND/OR) | in `results` call | ❌ we filter client-side post-match |
| Per-dimension vector_score / radar | returned by engine | ⚠ approximated client-side |
| Only real lever | — | `sources` + the **job definition** |

**Conclusion:** the public API derives the candidate SET from the JOB
(skills/must-have/function-level/education/language/location). It exposes no
weight, no soft/vector toggle, no server-side filter params.

### Replication strategy in findtalent (task #93)
1. **Equalizer (5 weights):** keep as an INSTANT LOCAL re-rank of the fetched
   shortlist (0 API calls, 0 credits). Cannot be sent to the public API — be
   honest in the UI that it reorders, doesn't re-query.
2. **Filters that change the SET** (must-have skills, skill set, function level,
   education level, location): only achievable by EDITING THE JOB and re-running
   the public match. This is the existing project-edit + non-destructive rematch
   path (clears `eightvanceJobId` → fresh job → fresh match; free match call, no
   credit; reveal still costs). Surface a "Re-match with these preferences"
   button that pushes the set-changing prefs into the job and reruns.
3. **Full scout-router parity** (true weighted re-match, server filters, real
   radar) would require direct access to `tm-scout-router` with the match-app's
   internal auth/scopes — undocumented, almost certainly not granted to a public
   client. Out of scope unless 8vance exposes it.

PROD job-write: build it, deploy/run only on Alex's go (never auto-mutate PROD).
