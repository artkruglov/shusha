-- One «what gets in the way» question per person and local week: the ten-minute tick finds Saturday
-- afternoon, and without this index every later tick of the same afternoon would ask again.
CREATE UNIQUE INDEX initiative_messages_feedback_ask_week
  ON initiative_messages(user_id, (date_trunc('week', sent_on::timestamp)::date))
  WHERE kind = 'feedback_ask';
