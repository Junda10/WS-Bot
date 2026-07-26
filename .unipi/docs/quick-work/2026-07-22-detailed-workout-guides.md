---
title: "Expand WSB detailed workout guides"
type: quick-work
date: 2026-07-22
---

# Expand WSB detailed workout guides

## Task
Expand all A/B/C training days into the requested detailed Chinese return-to-training format while preserving the existing fitness commands, Saturday/Monday/Wednesday rotation, concise rest/weekly messages, and daily fitness cron.

## Changes
- Refactored `workout.js` from short duplicated exercise lines into structured A/B/C plan data and one deterministic `formatWorkout()` implementation.
- Standardized every training guide on seven sections: 10-minute warm-up, main exercises, core circuit, treadmill finisher, training principles, post-workout nutrition/hydration, and star-rated intensity/fatigue target.
- Added explicit per-set beginner-return weights, reps, and rest periods. A retains the Day 1 squat/push/pull return emphasis; B uses a hinge/pull/single-leg emphasis; C uses stable leg-press/shoulder/arm work while all three remain full-body sessions.
- Added conservative load-adjustment wording, 2-3 reps in reserve with no forced failure, and stop/reduce guidance for pain, dizziness, or other marked discomfort without claiming medical certainty.
- Made date input injectable in `todayMessage()` and `weekdayInTz()` so timezone, training-day mapping, and rest behavior are deterministic in tests.
- Added `test/workout.test.js` for shared hierarchy, kg × reps/rest details, distinct focuses, safety wording, WhatsApp-safe length, timezone/day mapping, rest days, weekly overview, and command aliases. Existing regression coverage continues to verify the fitness cron registration.

## Verification
- `node --test test/workout.test.js` — 7/7 passed.
- `npm test` — 282/282 passed, 0 failed (offline).
- `node --check workout.js` and `node --check test/workout.test.js` — passed.
- `git diff --check` — passed.

## Notes
- `!健身`, `!fitness`, `!workout`, and `!gym` still use `todayMessage()`; their A/B/C forms use `formatWorkout()`. The scheduled reminder also calls `todayMessage()`, so training days automatically receive the same detailed output.
- Weekly overview and rest-day output intentionally remain concise.
- The real `.env` was not edited, and PM2 was not restarted.
