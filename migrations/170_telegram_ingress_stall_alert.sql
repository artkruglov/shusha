-- A message whose dispatch began and is still processing long after any turn should have answered means a stuck turn
-- (2 October 2026 on Ilya's installation: a private chat was silent for 8.5 hours and nobody was told). The operator is
-- alerted once per such message; this column records that the alert was claimed.
ALTER TABLE telegram_ingress_updates ADD COLUMN stall_alerted_at timestamptz;
