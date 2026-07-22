-- OCR extraction metadata and retryable NEEDS_OCR lifecycle.

ALTER TABLE attachments ADD COLUMN extraction_metadata_json TEXT CHECK (
  extraction_metadata_json IS NULL OR json_valid(extraction_metadata_json)
);

DROP TRIGGER attachments_extraction_state_insert_guard;
DROP TRIGGER attachments_extraction_state_update_guard;

-- Images were intentionally NOT_APPLICABLE before OCR support. Re-open only
-- archived, non-parsed historical rows; never overwrite successful evidence.
UPDATE attachments
SET parse_status = 'PENDING', processing_status = 'UNPARSED', retryable = 1,
    parse_error = NULL, last_error_code = NULL,
    processing_claim_id = NULL, processing_lease_until = NULL,
    updated_at = MAX(updated_at, COALESCE(archived_at, updated_at))
WHERE deleted_at IS NULL AND blob_sha256 IS NOT NULL
  AND detected_extension IN ('jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp')
  AND parse_status IN ('NOT_APPLICABLE', 'SAVED_UNPARSED', 'FAILED');

-- Migration 006 recognized scanned PDFs but made NEEDS_OCR terminal. They are
-- now durable recovery candidates. Runtime PM_OCR_ENABLED=false processes each
-- candidate once into terminal NEEDS_OCR/retryable=0, avoiding retry loops.
UPDATE attachments
SET processing_status = 'UNPARSED', retryable = 1,
    processing_claim_id = NULL, processing_lease_until = NULL
WHERE deleted_at IS NULL AND blob_sha256 IS NOT NULL
  AND detected_extension = 'pdf' AND parse_status = 'NEEDS_OCR';

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
    OR (NEW.parse_status = 'SAVED_UNPARSED'
      AND NEW.processing_status = 'UNPARSED' AND NEW.retryable = 0
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0)
    OR (NEW.parse_status = 'NEEDS_OCR'
      AND NEW.processing_status = 'UNPARSED' AND NEW.retryable IN (0, 1)
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
    OR (NEW.parse_status = 'SAVED_UNPARSED'
      AND NEW.processing_status = 'UNPARSED' AND NEW.retryable = 0
      AND NEW.extracted_text IS NULL AND NEW.extracted_char_count IS NULL
      AND NEW.extraction_truncated = 0)
    OR (NEW.parse_status = 'NEEDS_OCR'
      AND NEW.processing_status = 'UNPARSED' AND NEW.retryable IN (0, 1)
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
