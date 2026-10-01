-- The turn resumed after a Telegram approval carries freshly read policy (role, scopes, group)
-- but none of the requesting turn's context: sandbox session, timeline position, visible
-- entries, turn start. On 26 September 2026 the first live browser_confirm failed with
-- AGENT_SANDBOX_SESSION_CONTEXT_INVALID and the resumed turn could bind neither memory sources
-- nor chat preferences. The approval now keeps that context as one object; it never carries
-- authorization, which the resume re-reads from the database.
ALTER TABLE telegram_hitl_approvals
  ADD COLUMN turn_attributes jsonb
    CHECK (turn_attributes IS NULL OR jsonb_typeof(turn_attributes) = 'object');
