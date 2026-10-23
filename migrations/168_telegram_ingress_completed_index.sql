-- Completed Telegram updates are purged after a retention window (security review, 5 October
-- 2026); the minute dispatcher looks for the oldest ones, so they are indexed by completion time
-- instead of scanning the queue with its raw payloads every minute.
CREATE INDEX telegram_ingress_updates_completed_at
  ON telegram_ingress_updates (completed_at)
  WHERE status = 'completed';
