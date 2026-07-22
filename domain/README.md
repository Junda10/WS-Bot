# PM domain rules

Task 4 keeps lifecycle and authorization decisions in the service layer. Runtime callers must use `PermissionService` before media downloads or AI calls and `IssueService` for issue mutations; repositories are persistence primitives, not authorization boundaries.

## Lifecycle

The only normal forward path is:

`WAITING_TEVAU -> REPLIED -> RESOLVED -> ARCHIVED`

The first ERIC-confirmed reply performs the first transition. Further confirmed replies remain append-only on `REPLIED`. A member may resolve only a `REPLIED` issue, and an administrator may archive only a `RESOLVED` issue.

Moving a reply is an administrator-only correction. It is limited to active `REPLIED` sources and `WAITING_TEVAU`/`REPLIED` targets. The affected statuses and first-response timestamps are recomputed from the remaining confirmed replies, and both issue timelines receive append-only movement events.

## Restore rules

1. Restoring a soft-deleted issue only restores visibility. Its lifecycle state and lifecycle timestamps are preserved.
2. Restoring a visible `ARCHIVED` issue reopens it as `RESOLVED` and clears `archived_at`.
3. Therefore, a deleted archived issue requires two explicit restore operations: restore visibility first, then reopen the archive. This avoids hiding two state changes in one audit event.

Every service mutation records canonical actor JID, timestamp from the injected clock, a non-empty reason, and before/after JSON. Issue deletion is soft deletion; public `TVn` IDs are never reused.
