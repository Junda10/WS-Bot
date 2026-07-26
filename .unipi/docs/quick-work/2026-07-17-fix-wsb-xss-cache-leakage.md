---
title: "Fix WSB stored XSS and cross-user reply-cache leakage"
type: quick-work
date: 2026-07-17
---

# Fix WSB stored XSS and cross-user reply-cache leakage

## Task
Fix the stored XSS vulnerability in the generated-site index and prevent personalized AI replies from being reused across users or conversations.

## Changes
- `website-server.js`: HTML-escape metadata rendered on the public index, URL-encode site slugs, and export the app/escaping helper without opening a listener when imported by tests.
- `cache.js`: namespace cache entries by conversation and sender, including approximate matches, while ignoring legacy unscoped entries during scoped lookups.
- `index.js`: pass a cache scope composed from the chat and sender IDs for smart replies.
- `test/security-regressions.js`: cover HTML escaping and cache isolation across users and chats.
- `package.json`: run the new security regression checks from `npm test`.

## Verification
- `npm test`
- `node --check index.js`
- `node --check cache.js`
- `node --check website-server.js`
- `git diff --check`

## Notes
Existing unrelated uncommitted fitness, conversation-history, and Claude-agent work was preserved and excluded from this commit. Existing legacy cache entries are not used by scoped smart-reply lookups, preventing old personalized replies from leaking.
