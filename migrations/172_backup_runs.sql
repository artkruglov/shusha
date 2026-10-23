-- One row per nightly or milestone backup, written by the host's backup.py after the uploads (9 October 2026).
-- Backups went to the Yandex bucket only, while the installation moved to Fly after the zone outage and Yandex had
-- more incidents; a silently failing backup was found by nobody. The owner's morning digest reads the latest row:
-- which stores took the copy and which refused it. The table describes the installation, not a family.
CREATE TABLE backup_runs (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  archive_key text NOT NULL,
  archive_bytes bigint NOT NULL CHECK (archive_bytes >= 0),
  stores_ok text[] NOT NULL,
  stores_failed text[] NOT NULL
);
CREATE INDEX backup_runs_created_at ON backup_runs (created_at DESC);
