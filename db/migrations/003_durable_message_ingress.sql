-- Durable message routing claims and immutable quoted evidence snapshots.
-- Rows created before this migration were already routed by the Task 5 ingress, so
-- backfill them as processed; new rows retain the PENDING default.

ALTER TABLE messages ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (processing_status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'));
ALTER TABLE messages ADD COLUMN processing_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(processing_attempt_count) = 'integer' AND processing_attempt_count >= 0);
ALTER TABLE messages ADD COLUMN processing_claim_id TEXT;
ALTER TABLE messages ADD COLUMN processing_started_at INTEGER
  CHECK (processing_started_at IS NULL OR (typeof(processing_started_at) = 'integer' AND processing_started_at >= 0));
ALTER TABLE messages ADD COLUMN processing_lease_expires_at INTEGER
  CHECK (processing_lease_expires_at IS NULL OR (typeof(processing_lease_expires_at) = 'integer' AND processing_lease_expires_at >= 0));
ALTER TABLE messages ADD COLUMN processing_completed_at INTEGER
  CHECK (processing_completed_at IS NULL OR (typeof(processing_completed_at) = 'integer' AND processing_completed_at >= 0));
ALTER TABLE messages ADD COLUMN processing_last_error TEXT;

ALTER TABLE messages ADD COLUMN quoted_body TEXT;
ALTER TABLE messages ADD COLUMN quoted_sender_jid TEXT;
ALTER TABLE messages ADD COLUMN quoted_sent_at INTEGER
  CHECK (quoted_sent_at IS NULL OR (typeof(quoted_sent_at) = 'integer' AND quoted_sent_at >= 0));
ALTER TABLE messages ADD COLUMN quoted_media_json TEXT
  CHECK (quoted_media_json IS NULL OR json_valid(quoted_media_json));

UPDATE messages
SET processing_status = 'PROCESSED',
    processing_attempt_count = 1,
    processing_completed_at = received_at;

CREATE INDEX messages_processing_claim_idx
  ON messages(processing_status, processing_lease_expires_at, id);

CREATE TRIGGER messages_processing_state_insert_guard BEFORE INSERT ON messages
WHEN NOT (
  (NEW.processing_status = 'PENDING'
    AND NEW.processing_claim_id IS NULL
    AND NEW.processing_started_at IS NULL
    AND NEW.processing_lease_expires_at IS NULL
    AND NEW.processing_completed_at IS NULL
    AND NEW.processing_last_error IS NULL)
  OR
  (NEW.processing_status = 'PROCESSING'
    AND NEW.processing_attempt_count > 0
    AND NEW.processing_claim_id IS NOT NULL
    AND length(trim(NEW.processing_claim_id)) > 0
    AND NEW.processing_started_at IS NOT NULL
    AND NEW.processing_lease_expires_at >= NEW.processing_started_at
    AND NEW.processing_completed_at IS NULL
    AND NEW.processing_last_error IS NULL)
  OR
  (NEW.processing_status = 'PROCESSED'
    AND NEW.processing_attempt_count > 0
    AND NEW.processing_claim_id IS NULL
    AND NEW.processing_lease_expires_at IS NULL
    AND NEW.processing_completed_at IS NOT NULL
    AND NEW.processing_last_error IS NULL)
  OR
  (NEW.processing_status = 'FAILED'
    AND NEW.processing_attempt_count > 0
    AND NEW.processing_claim_id IS NULL
    AND NEW.processing_lease_expires_at IS NULL
    AND NEW.processing_completed_at IS NULL
    AND NEW.processing_last_error IS NOT NULL
    AND length(trim(NEW.processing_last_error)) > 0)
) BEGIN
  SELECT RAISE(ABORT, 'invalid message processing state');
END;

CREATE TRIGGER messages_processing_state_update_guard BEFORE UPDATE OF
  processing_status, processing_attempt_count, processing_claim_id,
  processing_started_at, processing_lease_expires_at, processing_completed_at,
  processing_last_error ON messages
WHEN NOT (
  (NEW.processing_status = 'PENDING'
    AND NEW.processing_claim_id IS NULL
    AND NEW.processing_started_at IS NULL
    AND NEW.processing_lease_expires_at IS NULL
    AND NEW.processing_completed_at IS NULL
    AND NEW.processing_last_error IS NULL)
  OR
  (NEW.processing_status = 'PROCESSING'
    AND NEW.processing_attempt_count > 0
    AND NEW.processing_claim_id IS NOT NULL
    AND length(trim(NEW.processing_claim_id)) > 0
    AND NEW.processing_started_at IS NOT NULL
    AND NEW.processing_lease_expires_at >= NEW.processing_started_at
    AND NEW.processing_completed_at IS NULL
    AND NEW.processing_last_error IS NULL)
  OR
  (NEW.processing_status = 'PROCESSED'
    AND NEW.processing_attempt_count > 0
    AND NEW.processing_claim_id IS NULL
    AND NEW.processing_lease_expires_at IS NULL
    AND NEW.processing_completed_at IS NOT NULL
    AND NEW.processing_last_error IS NULL)
  OR
  (NEW.processing_status = 'FAILED'
    AND NEW.processing_attempt_count > 0
    AND NEW.processing_claim_id IS NULL
    AND NEW.processing_lease_expires_at IS NULL
    AND NEW.processing_completed_at IS NULL
    AND NEW.processing_last_error IS NOT NULL
    AND length(trim(NEW.processing_last_error)) > 0)
) BEGIN
  SELECT RAISE(ABORT, 'invalid message processing state');
END;

CREATE TRIGGER messages_quoted_evidence_immutable BEFORE UPDATE OF
  quoted_body, quoted_sender_jid, quoted_sent_at, quoted_media_json ON messages
WHEN OLD.quoted_body IS NOT NEW.quoted_body
  OR OLD.quoted_sender_jid IS NOT NEW.quoted_sender_jid
  OR OLD.quoted_sent_at IS NOT NEW.quoted_sent_at
  OR OLD.quoted_media_json IS NOT NEW.quoted_media_json BEGIN
  SELECT RAISE(ABORT, 'quoted evidence snapshot is immutable');
END;
