-- Retention evidence snapshots and auditable maintenance outcomes.

CREATE TABLE retention_message_snapshots (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE RESTRICT,
  message_uid TEXT NOT NULL,
  whatsapp_message_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE RESTRICT,
  sender_jid TEXT NOT NULL,
  sender_display_name TEXT,
  message_type TEXT NOT NULL,
  body_snapshot TEXT,
  quoted_whatsapp_message_id TEXT,
  quoted_body_snapshot TEXT,
  quoted_sender_jid TEXT,
  quoted_sent_at INTEGER,
  quoted_media_json TEXT CHECK (quoted_media_json IS NULL OR json_valid(quoted_media_json)),
  sent_at INTEGER NOT NULL,
  evidence_reasons_json TEXT NOT NULL CHECK (json_valid(evidence_reasons_json)),
  snapshotted_at INTEGER NOT NULL CHECK (
    typeof(snapshotted_at) = 'integer' AND snapshotted_at >= 0
  )
) STRICT;

CREATE INDEX retention_snapshots_chat_sent_idx
  ON retention_message_snapshots(chat_id, sent_at, message_id);

CREATE TRIGGER retention_snapshots_immutable_update
BEFORE UPDATE ON retention_message_snapshots BEGIN
  SELECT RAISE(ABORT, 'retention evidence snapshots are immutable');
END;

CREATE TRIGGER retention_snapshots_immutable_delete
BEFORE DELETE ON retention_message_snapshots BEGIN
  SELECT RAISE(ABORT, 'retention evidence snapshots are immutable');
END;

CREATE TABLE maintenance_runs (
  id INTEGER PRIMARY KEY,
  run_uid TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN ('CLEANUP', 'BACKUP', 'OFFSITE')),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  started_at INTEGER NOT NULL CHECK (typeof(started_at) = 'integer' AND started_at >= 0),
  completed_at INTEGER CHECK (
    completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at >= started_at)
  ),
  artifact_name TEXT,
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  error_code TEXT,
  error_message TEXT,
  CHECK ((status = 'RUNNING' AND completed_at IS NULL)
      OR (status <> 'RUNNING' AND completed_at IS NOT NULL)),
  CHECK ((status = 'FAILED' AND error_message IS NOT NULL)
      OR status <> 'FAILED')
) STRICT;

CREATE INDEX maintenance_runs_operation_time_idx
  ON maintenance_runs(operation, started_at DESC, id DESC);

-- Terminal, unconfirmed sessions are disposable retention data. Confirmed sessions
-- remain protected by issue_replies and are never selected by cleanup.
DROP TRIGGER reply_candidates_final_immutable_delete;
CREATE TRIGGER reply_candidates_final_immutable_delete BEFORE DELETE ON reply_match_candidates
WHEN NOT EXISTS (
  SELECT 1 FROM reply_match_sessions
  WHERE id = OLD.session_id
    AND ((status = 'PENDING' AND ai_status = 'PROCESSING')
      OR status IN ('CANCELLED', 'EXPIRED'))
) BEGIN
  SELECT RAISE(ABORT, 'final reply candidates are immutable');
END;
