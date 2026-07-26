---
title: "Remove WSB exchange-rate feature"
type: quick-work
date: 2026-07-22
---

# Remove WSB exchange-rate feature

## Task
Completely remove WSB's exchange-rate schedules, commands, smart-chat integration, configuration, implementation, and feature documentation while preserving news, fitness, and Tevau PM behavior.

## Changes
- Deleted `fx.js` and removed its import, daily task, sender, command handlers/help entry, and smart-chat detection/context/cache bypass from `index.js`.
- Removed exchange-rate configuration and validation from `config.js`, and removed all related example variables from `.env.example` without changing the real `.env`.
- Added testable news/fitness schedule registration and dedicated legacy-command recognition seams.
- Updated README, operations documents, and historical workflow documents so they no longer claim the removed feature exists.
- Added `test/exchange-rate-removal.test.js` to prove stale environment values cannot register an extra cron and retired commands cannot reach a network-backed dedicated path.

## Verification
- `node --test test/exchange-rate-removal.test.js` — 2/2 passed.
- `npm test` — 275/275 passed, 0 failed (offline).
- `node --check` passed for changed JavaScript entry points, helpers, and regression test.
- `git diff --check` passed.
- Repository search found removed identifiers only in the intentional regression test (plus an unrelated lockfile integrity hash substring).

## Notes
- Shared dependencies such as `axios`, which remain used by weather, news, and AI code, were retained.
- News and fitness registration remain in the legacy registrar; Tevau PM's three persistent summary schedules are unchanged and remain covered by the full suite.
- PM2 was not restarted because production PM JIDs are not configured. The currently running process therefore remains active on the prior loaded code until a safe, configured restart deploys this commit.
