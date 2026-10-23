-- A weekly «what gets in the way» question to friend families during the beta (19 October 2026).
--
-- /feedback exists, but nobody types a command unasked. Once a week the bot asks a member of a family other
-- than the operator's, by the same initiative rule as the weekly review (switch, quiet hours, pause after
-- silence, daily limit), and at most four times in all. The question is a started conversation like the
-- others: it is counted in `initiative_messages` and recorded in the private chat's deliveries.
--
-- A new enum value cannot be used in the transaction that adds it, so the weekly index is 185.
ALTER TYPE initiative_kind ADD VALUE 'feedback_ask';
ALTER TYPE proactive_delivery_source_kind ADD VALUE 'feedback_ask';
