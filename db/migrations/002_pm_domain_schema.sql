-- Durable PM, message, attachment, reply matching, and summary domain schema.
-- Every timestamp is a non-negative UTC epoch millisecond supplied by the application.

CREATE TABLE chats (
  id INTEGER PRIMARY KEY,
  chat_uid TEXT NOT NULL UNIQUE CHECK (length(trim(chat_uid)) > 0),
  jid TEXT NOT NULL UNIQUE CHECK (length(trim(jid)) > 0),
  timezone TEXT NOT NULL CHECK (length(trim(timezone)) > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at >= 0)),
  CHECK (updated_at >= created_at),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
) STRICT;

-- A permission is a chat-scoped identity. Roles are separate so one JID may be
-- both ERIC and ADMIN. ADMIN membership implication is applied by the repository;
-- it deliberately does not imply ERIC.
CREATE TABLE permissions (
  id INTEGER PRIMARY KEY,
  permission_uid TEXT NOT NULL UNIQUE CHECK (length(trim(permission_uid)) > 0),
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE RESTRICT,
  canonical_jid TEXT NOT NULL CHECK (length(trim(canonical_jid)) > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at >= 0)),
  UNIQUE (chat_id, canonical_jid),
  UNIQUE (id, chat_id),
  CHECK (updated_at >= created_at),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
) STRICT;

CREATE TABLE permission_roles (
  permission_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('MEMBER', 'ERIC', 'ADMIN')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at >= 0)),
  PRIMARY KEY (permission_id, role),
  FOREIGN KEY (permission_id, chat_id) REFERENCES permissions(id, chat_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
) STRICT, WITHOUT ROWID;

CREATE INDEX permission_roles_chat_role_idx
  ON permission_roles(chat_id, role, enabled) WHERE deleted_at IS NULL;

CREATE TABLE jid_aliases (
  id INTEGER PRIMARY KEY,
  alias_uid TEXT NOT NULL UNIQUE CHECK (length(trim(alias_uid)) > 0),
  permission_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  alias_jid TEXT NOT NULL CHECK (length(trim(alias_jid)) > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at >= 0)),
  FOREIGN KEY (permission_id, chat_id) REFERENCES permissions(id, chat_id) ON DELETE RESTRICT,
  UNIQUE (chat_id, alias_jid),
  CHECK (updated_at >= created_at),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
) STRICT;

CREATE INDEX jid_aliases_permission_idx
  ON jid_aliases(permission_id) WHERE deleted_at IS NULL;

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  message_uid TEXT NOT NULL UNIQUE CHECK (length(trim(message_uid)) > 0),
  whatsapp_message_id TEXT NOT NULL UNIQUE CHECK (length(trim(whatsapp_message_id)) > 0),
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE RESTRICT,
  sender_jid TEXT NOT NULL CHECK (length(trim(sender_jid)) > 0),
  message_type TEXT NOT NULL DEFAULT 'TEXT' CHECK (message_type IN ('TEXT', 'MEDIA', 'SYSTEM')),
  body TEXT,
  quoted_message_id INTEGER,
  quoted_message_chat_id INTEGER,
  quoted_whatsapp_message_id TEXT,
  sent_at INTEGER NOT NULL CHECK (typeof(sent_at) = 'integer' AND sent_at >= 0),
  received_at INTEGER NOT NULL CHECK (typeof(received_at) = 'integer' AND received_at >= 0),
  is_command INTEGER NOT NULL DEFAULT 0 CHECK (is_command IN (0, 1)),
  is_tombstone INTEGER NOT NULL DEFAULT 0 CHECK (is_tombstone IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at >= 0)),
  UNIQUE (id, chat_id),
  FOREIGN KEY (quoted_message_id, quoted_message_chat_id)
    REFERENCES messages(id, chat_id) ON DELETE SET NULL,
  CHECK ((quoted_message_id IS NULL AND quoted_message_chat_id IS NULL)
      OR (quoted_message_id IS NOT NULL AND quoted_message_chat_id = chat_id
          AND quoted_whatsapp_message_id IS NOT NULL AND length(trim(quoted_whatsapp_message_id)) > 0)),
  CHECK (received_at >= sent_at),
  CHECK (is_tombstone = 0 OR (deleted_at IS NOT NULL AND body IS NULL)),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
) STRICT;

CREATE INDEX messages_chat_sent_idx ON messages(chat_id, sent_at, id);
CREATE INDEX messages_sender_sent_idx ON messages(sender_jid, sent_at);
CREATE INDEX messages_quoted_idx ON messages(quoted_message_id) WHERE quoted_message_id IS NOT NULL;

CREATE TRIGGER messages_source_snapshot_immutable BEFORE UPDATE OF quoted_whatsapp_message_id ON messages
WHEN OLD.quoted_whatsapp_message_id IS NOT NEW.quoted_whatsapp_message_id BEGIN
  SELECT RAISE(ABORT, 'quoted WhatsApp snapshot is immutable');
END;

CREATE TABLE sequences (
  name TEXT PRIMARY KEY CHECK (length(trim(name)) > 0),
  next_value INTEGER NOT NULL CHECK (typeof(next_value) = 'integer' AND next_value > 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
) STRICT, WITHOUT ROWID;

INSERT INTO sequences(name, next_value, updated_at) VALUES ('issue_tv', 1, 0);

CREATE TABLE issues (
  id INTEGER PRIMARY KEY,
  issue_uid TEXT NOT NULL UNIQUE CHECK (length(trim(issue_uid)) > 0),
  sequence_number INTEGER NOT NULL UNIQUE CHECK (typeof(sequence_number) = 'integer' AND sequence_number > 0),
  public_id TEXT NOT NULL UNIQUE CHECK (public_id = 'TV' || sequence_number),
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  description TEXT NOT NULL CHECK (length(description) <= 1000000),
  status TEXT NOT NULL CHECK (status IN ('WAITING_TEVAU', 'REPLIED', 'RESOLVED', 'ARCHIVED')),
  created_by_jid TEXT NOT NULL CHECK (length(trim(created_by_jid)) > 0),
  owner_jid TEXT,
  source_message_id INTEGER,
  source_message_chat_id INTEGER,
  source_whatsapp_message_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
  first_replied_at INTEGER CHECK (first_replied_at IS NULL OR (typeof(first_replied_at) = 'integer' AND first_replied_at >= 0)),
  resolved_at INTEGER CHECK (resolved_at IS NULL OR (typeof(resolved_at) = 'integer' AND resolved_at >= 0)),
  archived_at INTEGER CHECK (archived_at IS NULL OR (typeof(archived_at) = 'integer' AND archived_at >= 0)),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at >= 0)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision > 0),
  UNIQUE (id, chat_id),
  FOREIGN KEY (source_message_id, source_message_chat_id)
    REFERENCES messages(id, chat_id) ON DELETE SET NULL,
  CHECK ((source_message_id IS NULL AND source_message_chat_id IS NULL)
      OR (source_message_id IS NOT NULL AND source_message_chat_id = chat_id
          AND source_whatsapp_message_id IS NOT NULL AND length(trim(source_whatsapp_message_id)) > 0)),
  CHECK (updated_at >= created_at),
  CHECK (first_replied_at IS NULL OR first_replied_at >= created_at),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at),
  CHECK (archived_at IS NULL OR archived_at >= created_at),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
) STRICT;

CREATE INDEX issues_chat_status_created_idx
  ON issues(chat_id, status, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX issues_source_message_idx ON issues(source_message_id) WHERE source_message_id IS NOT NULL;

CREATE TRIGGER issues_source_snapshot_immutable BEFORE UPDATE OF source_whatsapp_message_id ON issues
WHEN OLD.source_whatsapp_message_id IS NOT NEW.source_whatsapp_message_id BEGIN
  SELECT RAISE(ABORT, 'issue source WhatsApp snapshot is immutable');
END;

CREATE TABLE issue_events (
  id INTEGER PRIMARY KEY,
  event_uid TEXT NOT NULL UNIQUE CHECK (length(trim(event_uid)) > 0),
  issue_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'CREATED', 'UPDATED', 'REPLY_CONFIRMED', 'RESOLVED', 'ARCHIVED',
    'RESTORED', 'DELETED', 'REPLY_MOVED'
  )),
  actor_jid TEXT NOT NULL CHECK (length(trim(actor_jid)) > 0),
  source_message_id INTEGER,
  source_message_chat_id INTEGER,
  source_whatsapp_message_id TEXT,
  reply_text TEXT,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  reason TEXT,
  occurred_at INTEGER NOT NULL CHECK (typeof(occurred_at) = 'integer' AND occurred_at >= 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  FOREIGN KEY (issue_id, chat_id) REFERENCES issues(id, chat_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id, source_message_chat_id)
    REFERENCES messages(id, chat_id) ON DELETE SET NULL,
  CHECK ((source_message_id IS NULL AND source_message_chat_id IS NULL)
      OR (source_message_id IS NOT NULL AND source_message_chat_id = chat_id
          AND source_whatsapp_message_id IS NOT NULL AND length(trim(source_whatsapp_message_id)) > 0)),
  CHECK (created_at >= occurred_at),
  CHECK ((event_type = 'REPLY_CONFIRMED' AND reply_text IS NOT NULL AND length(trim(reply_text)) > 0)
      OR (event_type <> 'REPLY_CONFIRMED' AND reply_text IS NULL))
) STRICT;

CREATE INDEX issue_events_issue_time_idx ON issue_events(issue_id, occurred_at, id);
CREATE INDEX issue_events_type_time_idx ON issue_events(event_type, occurred_at, id);

CREATE TRIGGER issue_events_snapshot_immutable BEFORE UPDATE OF source_whatsapp_message_id ON issue_events
WHEN OLD.source_whatsapp_message_id IS NOT NEW.source_whatsapp_message_id BEGIN
  SELECT RAISE(ABORT, 'event source WhatsApp snapshot is immutable');
END;

CREATE TRIGGER issue_events_append_only_update BEFORE UPDATE ON issue_events
WHEN OLD.event_uid IS NOT NEW.event_uid
  OR OLD.issue_id IS NOT NEW.issue_id
  OR OLD.chat_id IS NOT NEW.chat_id
  OR OLD.event_type IS NOT NEW.event_type
  OR OLD.actor_jid IS NOT NEW.actor_jid
  OR OLD.reply_text IS NOT NEW.reply_text
  OR OLD.before_json IS NOT NEW.before_json
  OR OLD.after_json IS NOT NEW.after_json
  OR OLD.reason IS NOT NEW.reason
  OR OLD.occurred_at IS NOT NEW.occurred_at
  OR OLD.created_at IS NOT NEW.created_at
  OR ((OLD.source_message_id IS NOT NEW.source_message_id
       OR OLD.source_message_chat_id IS NOT NEW.source_message_chat_id)
      AND NOT (OLD.source_message_id IS NOT NULL
               AND NEW.source_message_id IS NULL
               AND NEW.source_message_chat_id IS NULL)) BEGIN
  SELECT RAISE(ABORT, 'issue events are append-only');
END;

CREATE TRIGGER issue_events_append_only_delete BEFORE DELETE ON issue_events BEGIN
  SELECT RAISE(ABORT, 'issue events are append-only');
END;

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  attachment_uid TEXT NOT NULL UNIQUE CHECK (length(trim(attachment_uid)) > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE RESTRICT,
  message_id INTEGER,
  message_chat_id INTEGER,
  source_whatsapp_message_id TEXT,
  issue_id INTEGER,
  issue_chat_id INTEGER,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  detected_mime TEXT,
  size_bytes INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes >= 0),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  storage_key TEXT UNIQUE,
  retention_class TEXT NOT NULL CHECK (retention_class IN ('TEMPORARY', 'ISSUE')),
  processing_status TEXT NOT NULL CHECK (processing_status IN ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'UNPARSED')),
  extracted_text TEXT,
  parse_error TEXT,
  next_attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (typeof(next_attempt_number) = 'integer' AND next_attempt_number > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at >= 0)),
  UNIQUE (id, chat_id),
  FOREIGN KEY (message_id, message_chat_id) REFERENCES messages(id, chat_id) ON DELETE SET NULL,
  FOREIGN KEY (issue_id, issue_chat_id) REFERENCES issues(id, chat_id) ON DELETE RESTRICT,
  CHECK ((message_id IS NULL AND message_chat_id IS NULL)
      OR (message_id IS NOT NULL AND message_chat_id = chat_id
          AND source_whatsapp_message_id IS NOT NULL AND length(trim(source_whatsapp_message_id)) > 0)),
  CHECK ((issue_id IS NULL AND issue_chat_id IS NULL)
      OR (issue_id IS NOT NULL AND issue_chat_id = chat_id)),
  CHECK (message_id IS NOT NULL OR issue_id IS NOT NULL),
  CHECK (retention_class <> 'ISSUE' OR issue_id IS NOT NULL),
  CHECK (updated_at >= created_at),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
) STRICT;

CREATE INDEX attachments_message_idx ON attachments(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_issue_idx ON attachments(issue_id) WHERE issue_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX attachments_sha256_idx ON attachments(sha256) WHERE sha256 IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER attachments_source_snapshot_immutable BEFORE UPDATE OF source_whatsapp_message_id ON attachments
WHEN OLD.source_whatsapp_message_id IS NOT NEW.source_whatsapp_message_id BEGIN
  SELECT RAISE(ABORT, 'attachment source WhatsApp snapshot is immutable');
END;

CREATE TABLE attachment_processing_attempts (
  id INTEGER PRIMARY KEY,
  attempt_uid TEXT NOT NULL UNIQUE CHECK (length(trim(attempt_uid)) > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (typeof(attempt_number) = 'integer' AND attempt_number > 0),
  operation TEXT NOT NULL CHECK (operation IN ('DOWNLOAD', 'DETECT', 'EXTRACT', 'OCR', 'ARCHIVE')),
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED')),
  error_code TEXT,
  error_message TEXT,
  started_at INTEGER NOT NULL CHECK (typeof(started_at) = 'integer' AND started_at >= 0),
  completed_at INTEGER CHECK (completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at >= 0)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  UNIQUE (attachment_id, attempt_number),
  CHECK ((status = 'STARTED' AND completed_at IS NULL) OR (status <> 'STARTED' AND completed_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (created_at >= started_at)
) STRICT;

CREATE INDEX attachment_attempts_attachment_idx
  ON attachment_processing_attempts(attachment_id, attempt_number);

CREATE TABLE reply_match_sessions (
  id INTEGER PRIMARY KEY,
  session_uid TEXT NOT NULL UNIQUE CHECK (length(trim(session_uid)) > 0),
  token TEXT NOT NULL UNIQUE CHECK (length(trim(token)) BETWEEN 4 AND 128),
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE RESTRICT,
  source_message_id INTEGER,
  source_message_chat_id INTEGER,
  source_whatsapp_message_id TEXT NOT NULL CHECK (length(trim(source_whatsapp_message_id)) > 0),
  eric_jid TEXT NOT NULL CHECK (length(trim(eric_jid)) > 0),
  reply_text TEXT NOT NULL CHECK (length(trim(reply_text)) > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
  selected_issue_id INTEGER,
  selected_issue_chat_id INTEGER,
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at >= 0),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR (typeof(consumed_at) = 'integer' AND consumed_at >= 0)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
  UNIQUE (id, chat_id),
  UNIQUE (chat_id, source_whatsapp_message_id),
  FOREIGN KEY (source_message_id, source_message_chat_id)
    REFERENCES messages(id, chat_id) ON DELETE SET NULL,
  FOREIGN KEY (selected_issue_id, selected_issue_chat_id)
    REFERENCES issues(id, chat_id) ON DELETE RESTRICT,
  CHECK ((source_message_id IS NULL AND source_message_chat_id IS NULL)
      OR (source_message_id IS NOT NULL AND source_message_chat_id = chat_id)),
  CHECK ((selected_issue_id IS NULL AND selected_issue_chat_id IS NULL)
      OR (selected_issue_id IS NOT NULL AND selected_issue_chat_id = chat_id)),
  CHECK (expires_at >= created_at),
  CHECK (updated_at >= created_at),
  CHECK ((status = 'CONFIRMED' AND selected_issue_id IS NOT NULL AND consumed_at IS NOT NULL)
      OR (status <> 'CONFIRMED' AND selected_issue_id IS NULL AND selected_issue_chat_id IS NULL)),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
) STRICT;

CREATE INDEX reply_sessions_pending_idx
  ON reply_match_sessions(chat_id, eric_jid, expires_at) WHERE status = 'PENDING';

CREATE TRIGGER reply_sessions_snapshot_immutable BEFORE UPDATE OF source_whatsapp_message_id ON reply_match_sessions
WHEN OLD.source_whatsapp_message_id IS NOT NEW.source_whatsapp_message_id BEGIN
  SELECT RAISE(ABORT, 'reply source WhatsApp snapshot is immutable');
END;

CREATE TABLE reply_match_candidates (
  session_id INTEGER NOT NULL,
  issue_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  reason TEXT NOT NULL,
  PRIMARY KEY (session_id, issue_id),
  UNIQUE (session_id, position),
  FOREIGN KEY (session_id, chat_id) REFERENCES reply_match_sessions(id, chat_id) ON DELETE RESTRICT,
  FOREIGN KEY (issue_id, chat_id) REFERENCES issues(id, chat_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

-- Confirmed reply text is durable here; current_issue_id is the only mutable
-- association used by admin move-reply. Audit events remain append-only.
CREATE TABLE issue_replies (
  id INTEGER PRIMARY KEY,
  reply_uid TEXT NOT NULL UNIQUE CHECK (length(trim(reply_uid)) > 0),
  session_id INTEGER NOT NULL UNIQUE,
  chat_id INTEGER NOT NULL,
  original_issue_id INTEGER NOT NULL,
  current_issue_id INTEGER NOT NULL,
  source_message_id INTEGER,
  source_message_chat_id INTEGER,
  source_whatsapp_message_id TEXT NOT NULL CHECK (length(trim(source_whatsapp_message_id)) > 0),
  reply_text TEXT NOT NULL CHECK (length(trim(reply_text)) > 0),
  confirmed_by_jid TEXT NOT NULL CHECK (length(trim(confirmed_by_jid)) > 0),
  confirmed_at INTEGER NOT NULL CHECK (typeof(confirmed_at) = 'integer' AND confirmed_at >= 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  UNIQUE (id, chat_id),
  FOREIGN KEY (session_id, chat_id) REFERENCES reply_match_sessions(id, chat_id) ON DELETE RESTRICT,
  FOREIGN KEY (original_issue_id, chat_id) REFERENCES issues(id, chat_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_issue_id, chat_id) REFERENCES issues(id, chat_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id, source_message_chat_id)
    REFERENCES messages(id, chat_id) ON DELETE SET NULL,
  CHECK ((source_message_id IS NULL AND source_message_chat_id IS NULL)
      OR (source_message_id IS NOT NULL AND source_message_chat_id = chat_id)),
  CHECK (created_at >= confirmed_at)
) STRICT;

CREATE INDEX issue_replies_current_issue_idx ON issue_replies(current_issue_id, confirmed_at, id);

CREATE TRIGGER issue_replies_immutable_fields BEFORE UPDATE ON issue_replies
WHEN OLD.reply_uid IS NOT NEW.reply_uid
  OR OLD.session_id IS NOT NEW.session_id
  OR OLD.chat_id IS NOT NEW.chat_id
  OR OLD.original_issue_id IS NOT NEW.original_issue_id
  OR OLD.source_whatsapp_message_id IS NOT NEW.source_whatsapp_message_id
  OR OLD.reply_text IS NOT NEW.reply_text
  OR OLD.confirmed_by_jid IS NOT NEW.confirmed_by_jid
  OR OLD.confirmed_at IS NOT NEW.confirmed_at
  OR OLD.created_at IS NOT NEW.created_at BEGIN
  SELECT RAISE(ABORT, 'confirmed reply content and identity are immutable');
END;

CREATE TABLE summary_runs (
  id INTEGER PRIMARY KEY,
  run_uid TEXT NOT NULL UNIQUE CHECK (length(trim(run_uid)) > 0),
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE RESTRICT,
  report_type TEXT NOT NULL CHECK (report_type IN ('AUTO_10', 'AUTO_14', 'AUTO_20', 'MANUAL', 'RECOVERY')),
  window_start INTEGER NOT NULL CHECK (typeof(window_start) = 'integer' AND window_start >= 0),
  window_end INTEGER NOT NULL CHECK (typeof(window_end) = 'integer' AND window_end >= 0),
  scheduled_for INTEGER NOT NULL CHECK (typeof(scheduled_for) = 'integer' AND scheduled_for >= 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
  claimed_at INTEGER CHECK (claimed_at IS NULL OR (typeof(claimed_at) = 'integer' AND claimed_at >= 0)),
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR (typeof(lease_expires_at) = 'integer' AND lease_expires_at >= 0)),
  manifest_sealed_at INTEGER CHECK (manifest_sealed_at IS NULL OR (typeof(manifest_sealed_at) = 'integer' AND manifest_sealed_at >= 0)),
  expected_part_count INTEGER CHECK (expected_part_count IS NULL OR (typeof(expected_part_count) = 'integer' AND expected_part_count > 0)),
  manifest_hash TEXT CHECK (manifest_hash IS NULL OR (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*')),
  completed_at INTEGER CHECK (completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at >= 0)),
  last_error TEXT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
  UNIQUE (chat_id, report_type, window_start, window_end),
  CHECK (window_end > window_start),
  CHECK (updated_at >= created_at),
  CHECK (claimed_at IS NULL OR claimed_at >= created_at),
  CHECK (lease_expires_at IS NULL OR claimed_at IS NOT NULL),
  CHECK ((status = 'RUNNING' AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'RUNNING' AND lease_expires_at IS NULL)),
  CHECK ((manifest_sealed_at IS NULL AND expected_part_count IS NULL AND manifest_hash IS NULL)
      OR (manifest_sealed_at IS NOT NULL AND expected_part_count IS NOT NULL AND manifest_hash IS NOT NULL)),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK ((status = 'SUCCEEDED' AND completed_at IS NOT NULL AND manifest_sealed_at IS NOT NULL
          AND lease_expires_at IS NULL)
      OR (status <> 'SUCCEEDED' AND completed_at IS NULL))
) STRICT;

CREATE INDEX summary_runs_due_idx ON summary_runs(status, scheduled_for, lease_expires_at, id);
CREATE INDEX summary_runs_chat_window_idx ON summary_runs(chat_id, window_start, window_end);

CREATE TABLE summary_run_parts (
  id INTEGER PRIMARY KEY,
  part_uid TEXT NOT NULL UNIQUE CHECK (length(trim(part_uid)) > 0),
  run_id INTEGER NOT NULL REFERENCES summary_runs(id) ON DELETE RESTRICT,
  part_index INTEGER NOT NULL CHECK (typeof(part_index) = 'integer' AND part_index >= 0),
  content TEXT NOT NULL CHECK (length(content) > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
  send_lease_expires_at INTEGER CHECK (send_lease_expires_at IS NULL OR (typeof(send_lease_expires_at) = 'integer' AND send_lease_expires_at >= 0)),
  whatsapp_message_id TEXT UNIQUE,
  sent_at INTEGER CHECK (sent_at IS NULL OR (typeof(sent_at) = 'integer' AND sent_at >= 0)),
  last_error TEXT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
  UNIQUE (run_id, part_index),
  CHECK (updated_at >= created_at),
  CHECK ((status = 'SENT' AND whatsapp_message_id IS NOT NULL AND sent_at IS NOT NULL
          AND send_lease_expires_at IS NULL)
      OR (status <> 'SENT' AND sent_at IS NULL AND whatsapp_message_id IS NULL)),
  CHECK ((status = 'SENDING' AND send_lease_expires_at IS NOT NULL)
      OR (status <> 'SENDING' AND send_lease_expires_at IS NULL))
) STRICT;

CREATE INDEX summary_parts_outbox_idx ON summary_run_parts(run_id, status, part_index);

CREATE TRIGGER summary_parts_insert_guard BEFORE INSERT ON summary_run_parts BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM summary_runs
    WHERE id = NEW.run_id AND status = 'RUNNING' AND manifest_sealed_at IS NULL
  ) THEN RAISE(ABORT, 'summary manifest is sealed or run is not active') END;
END;

CREATE TRIGGER summary_parts_content_immutable BEFORE UPDATE ON summary_run_parts
WHEN OLD.run_id IS NOT NEW.run_id OR OLD.part_index IS NOT NEW.part_index
  OR OLD.content IS NOT NEW.content OR OLD.content_hash IS NOT NEW.content_hash BEGIN
  SELECT RAISE(ABORT, 'summary part manifest fields are immutable');
END;

CREATE TRIGGER summary_parts_delete_guard BEFORE DELETE ON summary_run_parts BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM summary_runs WHERE id = OLD.run_id AND manifest_sealed_at IS NOT NULL
  ) THEN RAISE(ABORT, 'sealed summary parts cannot be deleted') END;
END;

CREATE VIRTUAL TABLE issue_fts USING fts5(
  title,
  description,
  confirmed_replies,
  tokenize = 'trigram'
);

CREATE TRIGGER issues_fts_insert AFTER INSERT ON issues WHEN NEW.deleted_at IS NULL BEGIN
  INSERT INTO issue_fts(rowid, title, description, confirmed_replies)
  VALUES (NEW.id, NEW.title, NEW.description, '');
END;

CREATE TRIGGER issues_fts_update AFTER UPDATE OF title, description, deleted_at ON issues BEGIN
  DELETE FROM issue_fts WHERE rowid = OLD.id;
  INSERT INTO issue_fts(rowid, title, description, confirmed_replies)
  SELECT NEW.id, NEW.title, NEW.description,
         COALESCE((SELECT group_concat(reply_text, char(10))
                   FROM issue_replies WHERE current_issue_id = NEW.id), '')
  WHERE NEW.deleted_at IS NULL;
END;

CREATE TRIGGER issues_fts_delete AFTER DELETE ON issues BEGIN
  DELETE FROM issue_fts WHERE rowid = OLD.id;
END;

CREATE TRIGGER issue_replies_fts_insert AFTER INSERT ON issue_replies BEGIN
  DELETE FROM issue_fts WHERE rowid = NEW.current_issue_id;
  INSERT INTO issue_fts(rowid, title, description, confirmed_replies)
  SELECT i.id, i.title, i.description,
         COALESCE((SELECT group_concat(reply_text, char(10))
                   FROM issue_replies WHERE current_issue_id = i.id), '')
  FROM issues i WHERE i.id = NEW.current_issue_id AND i.deleted_at IS NULL;
END;

CREATE TRIGGER issue_replies_fts_move AFTER UPDATE OF current_issue_id ON issue_replies BEGIN
  DELETE FROM issue_fts WHERE rowid = OLD.current_issue_id;
  INSERT INTO issue_fts(rowid, title, description, confirmed_replies)
  SELECT i.id, i.title, i.description,
         COALESCE((SELECT group_concat(reply_text, char(10))
                   FROM issue_replies WHERE current_issue_id = i.id), '')
  FROM issues i WHERE i.id = OLD.current_issue_id AND i.deleted_at IS NULL;

  DELETE FROM issue_fts WHERE rowid = NEW.current_issue_id;
  INSERT INTO issue_fts(rowid, title, description, confirmed_replies)
  SELECT i.id, i.title, i.description,
         COALESCE((SELECT group_concat(reply_text, char(10))
                   FROM issue_replies WHERE current_issue_id = i.id), '')
  FROM issues i WHERE i.id = NEW.current_issue_id AND i.deleted_at IS NULL;
END;
