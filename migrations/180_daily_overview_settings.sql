-- The person's own morning overview: on or off, and at which hour (17 October 2026).
--
-- Until now the overview came at 08:00 local time, and the only switch was initiative_enabled, which
-- silences every message the bot starts, not just this one. People asked the model to move or stop the
-- overview, and it could only turn off everything. The overview now has its own switch and hour, set
-- with buttons under it (docs/telegram-task-buttons-plan.ru.md); quiet hours and the initiative switch
-- still win. NULL hour keeps the old time.
ALTER TABLE user_notification_settings
  ADD COLUMN daily_overview_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN daily_overview_hour smallint CHECK (daily_overview_hour BETWEEN 5 AND 12);
