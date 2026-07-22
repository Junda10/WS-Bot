-- Preserve the transport-provided sender display name for durable conversation history.
-- Authorization continues to use sender_jid; this field is presentation metadata only.
ALTER TABLE messages ADD COLUMN sender_display_name TEXT
  CHECK (
    sender_display_name IS NULL
    OR (length(trim(sender_display_name)) > 0 AND length(sender_display_name) <= 200)
  );
