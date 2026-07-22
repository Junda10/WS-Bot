-- Secure attachment content-addressing, provenance, retry state, and durable blob metadata.

CREATE TABLE attachment_blobs (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  storage_key TEXT NOT NULL UNIQUE CHECK (length(trim(storage_key)) > 0),
  -- Blob metadata describes byte identity only. MIME/extension are detection
  -- results for each attachment and may legitimately differ for identical text.
  size_bytes INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes >= 0),
  retention_class TEXT NOT NULL CHECK (retention_class IN ('TEMPORARY', 'ISSUE')),
  promotion_target_key TEXT UNIQUE CHECK (
    promotion_target_key IS NULL OR length(trim(promotion_target_key)) > 0
  ),
  promotion_issue_id INTEGER REFERENCES issues(id) ON DELETE RESTRICT,
  promotion_started_at INTEGER CHECK (
    promotion_started_at IS NULL OR (
      typeof(promotion_started_at) = 'integer' AND promotion_started_at >= 0
    )
  ),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
  CHECK (updated_at >= created_at)
) STRICT, WITHOUT ROWID;

ALTER TABLE attachments ADD COLUMN declared_mime TEXT;
ALTER TABLE attachments ADD COLUMN media_whatsapp_message_id TEXT;
ALTER TABLE attachments ADD COLUMN detected_extension TEXT CHECK (
  detected_extension IS NULL OR (
    length(detected_extension) BETWEEN 1 AND 16
    AND detected_extension NOT GLOB '*[^a-z0-9]*'
  )
);
ALTER TABLE attachments ADD COLUMN blob_sha256 TEXT REFERENCES attachment_blobs(sha256) ON DELETE RESTRICT;
ALTER TABLE attachments ADD COLUMN duplicate_of_attachment_id INTEGER REFERENCES attachments(id) ON DELETE RESTRICT;
ALTER TABLE attachments ADD COLUMN last_error_code TEXT;
ALTER TABLE attachments ADD COLUMN retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1));
ALTER TABLE attachments ADD COLUMN processing_claim_id TEXT;
ALTER TABLE attachments ADD COLUMN processing_lease_until INTEGER CHECK (
  processing_lease_until IS NULL OR (
    typeof(processing_lease_until) = 'integer' AND processing_lease_until >= 0
  )
);
ALTER TABLE attachments ADD COLUMN downloaded_at INTEGER CHECK (
  downloaded_at IS NULL OR (typeof(downloaded_at) = 'integer' AND downloaded_at >= 0)
);
ALTER TABLE attachments ADD COLUMN archived_at INTEGER CHECK (
  archived_at IS NULL OR (typeof(archived_at) = 'integer' AND archived_at >= 0)
);

-- Rows written by Task 5 contain transport-declared MIME in detected_mime.
-- Preserve it as provenance; Task 8 only writes detected_mime after byte inspection.
UPDATE attachments
SET declared_mime = detected_mime,
    detected_mime = NULL,
    media_whatsapp_message_id = source_whatsapp_message_id
WHERE detected_mime IS NOT NULL OR source_whatsapp_message_id IS NOT NULL;

CREATE INDEX attachment_media_source_idx ON attachments(media_whatsapp_message_id);
CREATE INDEX attachment_blob_idx ON attachments(blob_sha256) WHERE blob_sha256 IS NOT NULL;
CREATE INDEX attachment_retry_idx
  ON attachments(issue_id, processing_status, retryable, processing_lease_until, id)
  WHERE deleted_at IS NULL;

ALTER TABLE attachment_processing_attempts ADD COLUMN processing_claim_id TEXT;
ALTER TABLE attachment_processing_attempts ADD COLUMN retryable INTEGER CHECK (retryable IN (0, 1));
ALTER TABLE attachment_processing_attempts ADD COLUMN metadata_json TEXT CHECK (
  metadata_json IS NULL OR json_valid(metadata_json)
);

CREATE VIEW attachment_blob_live_references AS
SELECT b.sha256,
       COUNT(a.id) AS reference_count,
       SUM(CASE WHEN a.deleted_at IS NULL THEN 1 ELSE 0 END) AS live_reference_count,
       SUM(CASE WHEN a.issue_id IS NOT NULL OR a.retention_class = 'ISSUE' THEN 1 ELSE 0 END)
         AS issue_reference_count
FROM attachment_blobs b
-- Soft-deleted attachment rows still hold a real FK and must protect the blob.
LEFT JOIN attachments a ON a.blob_sha256 = b.sha256
GROUP BY b.sha256;
