-- Durable immutable evidence and AI outcome for idempotent !pm add replay.

CREATE TABLE issue_source_snapshots (
  issue_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  command_message_id INTEGER NOT NULL,
  command_whatsapp_message_id TEXT NOT NULL CHECK (length(trim(command_whatsapp_message_id)) > 0),
  source_message_id INTEGER,
  source_whatsapp_message_id TEXT NOT NULL CHECK (length(trim(source_whatsapp_message_id)) > 0),
  source_body TEXT,
  source_sender_jid TEXT,
  source_sent_at INTEGER CHECK (
    source_sent_at IS NULL OR (typeof(source_sent_at) = 'integer' AND source_sent_at >= 0)
  ),
  source_media_json TEXT CHECK (source_media_json IS NULL OR json_valid(source_media_json)),
  extraction_status TEXT NOT NULL CHECK (extraction_status IN ('AI_VALID', 'FALLBACK')),
  ai_model TEXT,
  ai_attempts INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(ai_attempts) = 'integer' AND ai_attempts >= 0
  ),
  ai_error_code TEXT,
  ai_error_message TEXT,
  uncertainties_json TEXT NOT NULL CHECK (json_valid(uncertainties_json)),
  source_summary TEXT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  FOREIGN KEY (issue_id, chat_id) REFERENCES issues(id, chat_id) ON DELETE RESTRICT,
  FOREIGN KEY (command_message_id, chat_id) REFERENCES messages(id, chat_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL,
  UNIQUE (chat_id, command_whatsapp_message_id)
) STRICT;

CREATE INDEX issue_source_snapshots_source_idx
  ON issue_source_snapshots(chat_id, source_whatsapp_message_id);

CREATE TRIGGER issue_source_snapshots_immutable_update BEFORE UPDATE ON issue_source_snapshots BEGIN
  SELECT RAISE(ABORT, 'issue source snapshots are immutable');
END;

CREATE TRIGGER issue_source_snapshots_immutable_delete BEFORE DELETE ON issue_source_snapshots BEGIN
  SELECT RAISE(ABORT, 'issue source snapshots are immutable');
END;
