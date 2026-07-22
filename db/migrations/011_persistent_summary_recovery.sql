-- Map every scheduled automatic window to the one durable run that owns delivery.
-- Direct runs own one window; a RECOVERY run may own several constituent windows.
-- The unique window key closes the cron/startup-recovery race transactionally.
CREATE TABLE summary_run_coverage (
  run_id INTEGER NOT NULL REFERENCES summary_runs(id) ON DELETE RESTRICT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE RESTRICT,
  report_type TEXT NOT NULL CHECK (report_type IN ('AUTO_10', 'AUTO_14', 'AUTO_20')),
  window_start INTEGER NOT NULL CHECK (typeof(window_start) = 'integer' AND window_start >= 0),
  window_end INTEGER NOT NULL CHECK (typeof(window_end) = 'integer' AND window_end >= 0),
  scheduled_for INTEGER NOT NULL CHECK (typeof(scheduled_for) = 'integer' AND scheduled_for >= 0),
  coverage_kind TEXT NOT NULL CHECK (coverage_kind IN ('DIRECT', 'COMBINED_RECOVERY')),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  PRIMARY KEY (chat_id, report_type, window_start, window_end),
  UNIQUE (run_id, report_type, window_start, window_end),
  CHECK (window_end > window_start)
) STRICT, WITHOUT ROWID;

CREATE INDEX summary_run_coverage_owner_idx
  ON summary_run_coverage(run_id, scheduled_for);

-- Preserve ownership for automatic ledgers created before this migration.
INSERT INTO summary_run_coverage (
  run_id, chat_id, report_type, window_start, window_end,
  scheduled_for, coverage_kind, created_at
)
SELECT id, chat_id, report_type, window_start, window_end,
       scheduled_for, 'DIRECT', created_at
FROM summary_runs
WHERE report_type IN ('AUTO_10', 'AUTO_14', 'AUTO_20');
