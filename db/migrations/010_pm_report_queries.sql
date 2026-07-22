-- Reporting reads are chat-scoped half-open time-window scans. The existing
-- type-first index cannot serve this access pattern without scanning other
-- chats and event types.

CREATE INDEX issue_events_chat_time_idx
  ON issue_events(chat_id, occurred_at, id);
