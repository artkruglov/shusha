-- Daily claims of the feature tip and the evening reflection (migration 195).
--
-- The ten-minute tick finds the same afternoon or evening several times; without these indexes every later tick of
-- the same day would write again. A feature tip comes at most once a local day (and only on Tuesday and Friday, by the
-- dispatcher); the evening reflection once a local day.
CREATE UNIQUE INDEX initiative_messages_feature_tip_daily
  ON initiative_messages(user_id, sent_on)
  WHERE kind = 'feature_tip';

CREATE UNIQUE INDEX initiative_messages_evening_reflection_daily
  ON initiative_messages(user_id, sent_on)
  WHERE kind = 'evening_reflection';
