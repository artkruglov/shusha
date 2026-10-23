-- Turning the bot on in a group without a family (15 October 2026). Any Telegram administrator of a
-- group writes /start there and the bot answers in it (migration 175 gave such a group its own scope);
-- /stop turns it off and erases the group. The operator holds two installation-wide numbers: how many
-- such groups may exist at once (0 closes the door, existing groups keep working) and the monthly model
-- budget a new group gets. One row; no person, chat or content.
CREATE TABLE familyless_group_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  max_groups integer NOT NULL CHECK (max_groups >= 0),
  default_monthly_budget_usd numeric(10, 2) NOT NULL CHECK (default_monthly_budget_usd > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO familyless_group_settings (max_groups, default_monthly_budget_usd) VALUES (20, 1.00);

CREATE INDEX telegram_groups_familyless ON telegram_groups (created_at) WHERE family_id IS NULL;
