-- The thread of a conversation survives the turn-limit rotation. A session rotates after 50 turns
-- (Eve replay limit); the new one started from nothing: memory keeps the facts, but what the chat
-- was about, what was decided and what is still open was lost. The summary of the retired session
-- is written on the row of its successor and shown once, in the first turn that reads it
-- (handoff_shown_at): two concurrent group messages prepare their context in parallel, and tying
-- the summary to the first timeline cursor could lose it. Size, latency and the number of source
-- entries sit next to it, so cost and completeness can be judged from the rows. Only the turn
-- limit hands over: a requested clean context and a quiet session carry nothing.
ALTER TABLE conversation_sessions
  ADD COLUMN handoff_text text CHECK (handoff_text IS NULL OR char_length(handoff_text) <= 3000),
  ADD COLUMN handoff_generated_at timestamptz,
  ADD COLUMN handoff_shown_at timestamptz,
  ADD COLUMN handoff_latency_ms integer CHECK (handoff_latency_ms IS NULL OR handoff_latency_ms >= 0),
  ADD COLUMN handoff_source_entries integer CHECK (handoff_source_entries IS NULL OR handoff_source_entries >= 0);
