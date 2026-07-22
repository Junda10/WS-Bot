-- Production reply matching snapshots, AI outcome, and durable WhatsApp prompt bindings.

ALTER TABLE reply_match_sessions ADD COLUMN source_sender_jid TEXT;
ALTER TABLE reply_match_sessions ADD COLUMN source_sent_at INTEGER;
ALTER TABLE reply_match_sessions ADD COLUMN source_media_json TEXT;
ALTER TABLE reply_match_sessions ADD COLUMN ai_status TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE reply_match_sessions ADD COLUMN ai_selected_public_id TEXT;
ALTER TABLE reply_match_sessions ADD COLUMN ai_confidence TEXT;
ALTER TABLE reply_match_sessions ADD COLUMN ai_reason TEXT;
ALTER TABLE reply_match_sessions ADD COLUMN ai_model TEXT;
ALTER TABLE reply_match_sessions ADD COLUMN ai_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reply_match_sessions ADD COLUMN ai_error_code TEXT;
ALTER TABLE reply_match_sessions ADD COLUMN ai_error_message TEXT;
ALTER TABLE reply_match_sessions ADD COLUMN suggestion_whatsapp_message_id TEXT;
ALTER TABLE reply_match_sessions ADD COLUMN suggestion_sent_at INTEGER;
ALTER TABLE reply_match_sessions ADD COLUMN confirmation_whatsapp_message_id TEXT;
ALTER TABLE reply_match_sessions ADD COLUMN confirmation_sent_at INTEGER;

CREATE UNIQUE INDEX reply_sessions_suggestion_message_uidx
  ON reply_match_sessions(suggestion_whatsapp_message_id)
  WHERE suggestion_whatsapp_message_id IS NOT NULL;
CREATE UNIQUE INDEX reply_sessions_confirmation_message_uidx
  ON reply_match_sessions(confirmation_whatsapp_message_id)
  WHERE confirmation_whatsapp_message_id IS NOT NULL;

CREATE TRIGGER reply_sessions_identity_immutable BEFORE UPDATE ON reply_match_sessions
WHEN OLD.session_uid IS NOT NEW.session_uid
  OR OLD.token IS NOT NEW.token
  OR OLD.chat_id IS NOT NEW.chat_id
  OR OLD.source_message_id IS NOT NEW.source_message_id
  OR OLD.source_message_chat_id IS NOT NEW.source_message_chat_id
  OR OLD.source_whatsapp_message_id IS NOT NEW.source_whatsapp_message_id
  OR OLD.eric_jid IS NOT NEW.eric_jid
  OR OLD.reply_text IS NOT NEW.reply_text
  OR OLD.source_sender_jid IS NOT NEW.source_sender_jid
  OR OLD.source_sent_at IS NOT NEW.source_sent_at
  OR OLD.source_media_json IS NOT NEW.source_media_json
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.created_at IS NOT NEW.created_at BEGIN
  SELECT RAISE(ABORT, 'reply session identity and source snapshot are immutable');
END;

CREATE TRIGGER reply_sessions_validate_insert BEFORE INSERT ON reply_match_sessions
WHEN NEW.ai_status NOT IN ('PROCESSING', 'MATCHED', 'NO_MATCH', 'FAILED', 'INVALID', 'LEGACY')
  OR NEW.ai_attempts < 0
  OR (NEW.source_sent_at IS NOT NULL AND NEW.source_sent_at < 0)
  OR (NEW.source_media_json IS NOT NULL AND NOT json_valid(NEW.source_media_json))
  OR (NEW.ai_confidence IS NOT NULL AND NEW.ai_confidence NOT IN ('low', 'medium', 'high'))
  OR (NEW.ai_selected_public_id IS NULL AND NEW.ai_confidence IS NOT NULL AND NEW.ai_confidence <> 'low')
  OR ((NEW.suggestion_whatsapp_message_id IS NULL) <> (NEW.suggestion_sent_at IS NULL))
  OR ((NEW.confirmation_whatsapp_message_id IS NULL) <> (NEW.confirmation_sent_at IS NULL)) BEGIN
  SELECT RAISE(ABORT, 'invalid reply session workflow fields');
END;

CREATE TRIGGER reply_sessions_validate_update BEFORE UPDATE ON reply_match_sessions
WHEN NEW.ai_status NOT IN ('PROCESSING', 'MATCHED', 'NO_MATCH', 'FAILED', 'INVALID', 'LEGACY')
  OR NEW.ai_attempts < 0
  OR (NEW.source_sent_at IS NOT NULL AND NEW.source_sent_at < 0)
  OR (NEW.source_media_json IS NOT NULL AND NOT json_valid(NEW.source_media_json))
  OR (NEW.ai_confidence IS NOT NULL AND NEW.ai_confidence NOT IN ('low', 'medium', 'high'))
  OR (NEW.ai_selected_public_id IS NULL AND NEW.ai_confidence IS NOT NULL AND NEW.ai_confidence <> 'low')
  OR ((NEW.suggestion_whatsapp_message_id IS NULL) <> (NEW.suggestion_sent_at IS NULL))
  OR ((NEW.confirmation_whatsapp_message_id IS NULL) <> (NEW.confirmation_sent_at IS NULL)) BEGIN
  SELECT RAISE(ABORT, 'invalid reply session workflow fields');
END;

CREATE TRIGGER reply_sessions_ai_once BEFORE UPDATE ON reply_match_sessions
WHEN OLD.ai_status <> 'PROCESSING' AND (
  OLD.ai_status IS NOT NEW.ai_status
  OR OLD.ai_selected_public_id IS NOT NEW.ai_selected_public_id
  OR OLD.ai_confidence IS NOT NEW.ai_confidence
  OR OLD.ai_reason IS NOT NEW.ai_reason
  OR OLD.ai_model IS NOT NEW.ai_model
  OR OLD.ai_attempts IS NOT NEW.ai_attempts
  OR OLD.ai_error_code IS NOT NEW.ai_error_code
  OR OLD.ai_error_message IS NOT NEW.ai_error_message
) BEGIN
  SELECT RAISE(ABORT, 'reply AI result is immutable');
END;

CREATE TRIGGER reply_sessions_message_bindings_immutable BEFORE UPDATE ON reply_match_sessions
WHEN (OLD.suggestion_whatsapp_message_id IS NOT NULL AND (
        OLD.suggestion_whatsapp_message_id IS NOT NEW.suggestion_whatsapp_message_id
        OR OLD.suggestion_sent_at IS NOT NEW.suggestion_sent_at))
  OR (OLD.confirmation_whatsapp_message_id IS NOT NULL AND (
        OLD.confirmation_whatsapp_message_id IS NOT NEW.confirmation_whatsapp_message_id
        OR OLD.confirmation_sent_at IS NOT NEW.confirmation_sent_at)) BEGIN
  SELECT RAISE(ABORT, 'reply WhatsApp message binding is immutable');
END;

CREATE TRIGGER reply_candidates_final_immutable_insert BEFORE INSERT ON reply_match_candidates
WHEN NOT EXISTS (
  SELECT 1 FROM reply_match_sessions
  WHERE id = NEW.session_id AND status = 'PENDING' AND ai_status = 'PROCESSING'
) BEGIN
  SELECT RAISE(ABORT, 'final reply candidates are immutable');
END;

CREATE TRIGGER reply_candidates_final_immutable_update BEFORE UPDATE ON reply_match_candidates
WHEN NOT EXISTS (
  SELECT 1 FROM reply_match_sessions
  WHERE id = OLD.session_id AND status = 'PENDING' AND ai_status = 'PROCESSING'
) BEGIN
  SELECT RAISE(ABORT, 'final reply candidates are immutable');
END;

CREATE TRIGGER reply_candidates_final_immutable_delete BEFORE DELETE ON reply_match_candidates
WHEN NOT EXISTS (
  SELECT 1 FROM reply_match_sessions
  WHERE id = OLD.session_id AND status = 'PENDING' AND ai_status = 'PROCESSING'
) BEGIN
  SELECT RAISE(ABORT, 'final reply candidates are immutable');
END;

ALTER TABLE issue_replies ADD COLUMN source_sender_jid TEXT;
ALTER TABLE issue_replies ADD COLUMN source_sent_at INTEGER;
ALTER TABLE issue_replies ADD COLUMN source_media_json TEXT;

CREATE TRIGGER issue_replies_snapshot_validate_insert BEFORE INSERT ON issue_replies
WHEN (NEW.source_sent_at IS NOT NULL AND NEW.source_sent_at < 0)
  OR (NEW.source_media_json IS NOT NULL AND NOT json_valid(NEW.source_media_json)) BEGIN
  SELECT RAISE(ABORT, 'invalid confirmed reply source snapshot');
END;

DROP TRIGGER issue_replies_immutable_fields;
CREATE TRIGGER issue_replies_immutable_fields BEFORE UPDATE ON issue_replies
WHEN OLD.reply_uid IS NOT NEW.reply_uid
  OR OLD.session_id IS NOT NEW.session_id
  OR OLD.chat_id IS NOT NEW.chat_id
  OR OLD.original_issue_id IS NOT NEW.original_issue_id
  OR OLD.source_whatsapp_message_id IS NOT NEW.source_whatsapp_message_id
  OR OLD.source_sender_jid IS NOT NEW.source_sender_jid
  OR OLD.source_sent_at IS NOT NEW.source_sent_at
  OR OLD.source_media_json IS NOT NEW.source_media_json
  OR OLD.reply_text IS NOT NEW.reply_text
  OR OLD.confirmed_by_jid IS NOT NEW.confirmed_by_jid
  OR OLD.confirmed_at IS NOT NEW.confirmed_at
  OR OLD.created_at IS NOT NEW.created_at BEGIN
  SELECT RAISE(ABORT, 'confirmed reply content and identity are immutable');
END;
