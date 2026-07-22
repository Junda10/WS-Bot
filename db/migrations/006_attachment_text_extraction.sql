-- Durable parser lifecycle, quoted-media provenance, and strict extraction invariants.

ALTER TABLE attachments ADD COLUMN parse_status TEXT CHECK (
  parse_status IS NULL OR parse_status IN (
    'NOT_APPLICABLE', 'PENDING', 'PARSING', 'PARSED',
    'SAVED_UNPARSED', 'NEEDS_OCR', 'FAILED'
  )
);
ALTER TABLE attachments ADD COLUMN extracted_char_count INTEGER CHECK (
  extracted_char_count IS NULL OR (
    typeof(extracted_char_count) = 'integer' AND extracted_char_count >= 0
  )
);
ALTER TABLE attachments ADD COLUMN extraction_truncated INTEGER NOT NULL DEFAULT 0
  CHECK (extraction_truncated IN (0, 1));

-- message_id remains the attachment's capture/command relation for backwards
-- compatibility. These snapshots separate that command from quoted media.
ALTER TABLE attachments ADD COLUMN capture_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE attachments ADD COLUMN capture_whatsapp_message_id TEXT;
ALTER TABLE attachments ADD COLUMN source_sender_jid TEXT;
ALTER TABLE attachments ADD COLUMN source_sent_at INTEGER CHECK (
  source_sent_at IS NULL OR (typeof(source_sent_at) = 'integer' AND source_sent_at >= 0)
);

UPDATE attachments
SET capture_message_id = message_id,
    capture_whatsapp_message_id = source_whatsapp_message_id,
    source_sender_jid = (SELECT sender_jid FROM messages WHERE messages.id = attachments.message_id),
    source_sent_at = (SELECT sent_at FROM messages WHERE messages.id = attachments.message_id);

-- Preserve rows archived before this migration. Empty legacy parser output is
-- not a valid PARSED state.
UPDATE attachments
SET parse_status = CASE
  WHEN extracted_text IS NOT NULL AND length(trim(extracted_text)) > 0 THEN 'PARSED'
  WHEN blob_sha256 IS NOT NULL
       AND detected_extension IN ('md', 'txt', 'pdf', 'docx') THEN
    CASE WHEN processing_status = 'FAILED' THEN 'FAILED' ELSE 'PENDING' END
  WHEN blob_sha256 IS NOT NULL THEN 'NOT_APPLICABLE'
  ELSE NULL
END,
processing_status = CASE
  WHEN extracted_text IS NOT NULL AND length(trim(extracted_text)) > 0 THEN 'READY'
  WHEN blob_sha256 IS NOT NULL AND processing_status = 'FAILED' THEN 'FAILED'
  WHEN blob_sha256 IS NOT NULL THEN 'UNPARSED'
  ELSE processing_status
END,
extracted_text = CASE
  WHEN extracted_text IS NOT NULL AND length(trim(extracted_text)) > 0 THEN extracted_text
  ELSE NULL
END,
extracted_char_count = CASE
  WHEN extracted_text IS NOT NULL AND length(trim(extracted_text)) > 0 THEN length(extracted_text)
  ELSE NULL
END,
extraction_truncated = 0,
retryable = CASE
  WHEN blob_sha256 IS NOT NULL
       AND detected_extension IN ('md', 'txt', 'pdf', 'docx')
       AND NOT (extracted_text IS NOT NULL AND length(trim(extracted_text)) > 0) THEN 1
  WHEN extracted_text IS NOT NULL AND length(trim(extracted_text)) > 0 THEN 0
  WHEN blob_sha256 IS NOT NULL THEN 0
  ELSE retryable
END;

CREATE INDEX attachment_parse_retry_idx
  ON attachments(parse_status, processing_status, retryable, id)
  WHERE deleted_at IS NULL AND blob_sha256 IS NOT NULL;
CREATE INDEX attachment_temporary_retention_idx
  ON attachments(retention_class, source_sent_at, archived_at, id)
  WHERE issue_id IS NULL;
CREATE INDEX attachment_source_window_idx
  ON attachments(chat_id, source_sent_at, id) WHERE deleted_at IS NULL;

CREATE TRIGGER attachments_extraction_state_insert_guard BEFORE INSERT ON attachments
WHEN NOT (
  ((NEW.blob_sha256 IS NULL AND NEW.parse_status IS NULL)
    OR (NEW.blob_sha256 IS NOT NULL AND NEW.parse_status IS NOT NULL))
  AND (
    (NEW.parse_status IS NULL
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0
      AND NEW.processing_status IN ('PENDING', 'PROCESSING', 'FAILED'))
    OR (NEW.parse_status = 'NOT_APPLICABLE'
      AND NEW.processing_status = 'UNPARSED' AND NEW.retryable = 0
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0)
    OR (NEW.parse_status = 'PENDING'
      AND NEW.processing_status = 'UNPARSED' AND NEW.retryable = 1
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0)
    OR (NEW.parse_status = 'PARSING'
      AND NEW.processing_status = 'PROCESSING' AND NEW.retryable = 1
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0)
    OR (NEW.parse_status = 'PARSED'
      AND NEW.processing_status = 'READY' AND NEW.retryable = 0
      AND NEW.extracted_text IS NOT NULL AND length(NEW.extracted_text) > 0
      AND NEW.extracted_char_count = length(NEW.extracted_text))
    OR (NEW.parse_status IN ('SAVED_UNPARSED', 'NEEDS_OCR')
      AND NEW.processing_status = 'UNPARSED' AND NEW.retryable = 0
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0)
    OR (NEW.parse_status = 'FAILED'
      AND NEW.processing_status = 'FAILED'
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0)
  )
  AND (
    (NEW.processing_status = 'PROCESSING'
      AND NEW.processing_claim_id IS NOT NULL
      AND length(trim(NEW.processing_claim_id)) > 0
      AND NEW.processing_lease_until IS NOT NULL)
    OR (NEW.processing_status IN ('PENDING', 'UNPARSED')
      AND NEW.processing_lease_until IS NULL)
    OR (NEW.processing_status IN ('READY', 'FAILED')
      AND NEW.processing_claim_id IS NULL AND NEW.processing_lease_until IS NULL)
  )
) BEGIN
  SELECT RAISE(ABORT, 'invalid attachment extraction state');
END;

CREATE TRIGGER attachments_extraction_state_update_guard BEFORE UPDATE OF
  blob_sha256, parse_status, processing_status, retryable, extracted_text,
  extracted_char_count, extraction_truncated, processing_claim_id,
  processing_lease_until ON attachments
WHEN NOT (
  ((NEW.blob_sha256 IS NULL AND NEW.parse_status IS NULL)
    OR (NEW.blob_sha256 IS NOT NULL AND NEW.parse_status IS NOT NULL))
  AND (
    (NEW.parse_status IS NULL
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0
      AND NEW.processing_status IN ('PENDING', 'PROCESSING', 'FAILED'))
    OR (NEW.parse_status = 'NOT_APPLICABLE'
      AND NEW.processing_status = 'UNPARSED' AND NEW.retryable = 0
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0)
    OR (NEW.parse_status = 'PENDING'
      AND NEW.processing_status = 'UNPARSED' AND NEW.retryable = 1
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0)
    OR (NEW.parse_status = 'PARSING'
      AND NEW.processing_status = 'PROCESSING' AND NEW.retryable = 1
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0)
    OR (NEW.parse_status = 'PARSED'
      AND NEW.processing_status = 'READY' AND NEW.retryable = 0
      AND NEW.extracted_text IS NOT NULL AND length(NEW.extracted_text) > 0
      AND NEW.extracted_char_count = length(NEW.extracted_text))
    OR (NEW.parse_status IN ('SAVED_UNPARSED', 'NEEDS_OCR')
      AND NEW.processing_status = 'UNPARSED' AND NEW.retryable = 0
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0)
    OR (NEW.parse_status = 'FAILED'
      AND NEW.processing_status = 'FAILED'
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0)
  )
  AND (
    (NEW.processing_status = 'PROCESSING'
      AND NEW.processing_claim_id IS NOT NULL
      AND length(trim(NEW.processing_claim_id)) > 0
      AND NEW.processing_lease_until IS NOT NULL)
    OR (NEW.processing_status IN ('PENDING', 'UNPARSED')
      AND NEW.processing_lease_until IS NULL)
    OR (NEW.processing_status IN ('READY', 'FAILED')
      AND NEW.processing_claim_id IS NULL AND NEW.processing_lease_until IS NULL)
  )
) BEGIN
  SELECT RAISE(ABORT, 'invalid attachment extraction state');
END;

CREATE TRIGGER attachments_capture_source_immutable BEFORE UPDATE OF
  capture_message_id, capture_whatsapp_message_id, source_sender_jid, source_sent_at
ON attachments
WHEN OLD.capture_message_id IS NOT NEW.capture_message_id
  OR OLD.capture_whatsapp_message_id IS NOT NEW.capture_whatsapp_message_id
  OR OLD.source_sender_jid IS NOT NEW.source_sender_jid
  OR OLD.source_sent_at IS NOT NEW.source_sent_at BEGIN
  SELECT RAISE(ABORT, 'attachment capture/source provenance is immutable');
END;
