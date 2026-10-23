-- Feature tips and the evening reflection (owner, 21 October 2026).
--
-- People used three of the bot's abilities and never heard of the rest: nobody sent a photo of homework, animated a
-- photo or mentioned the bot in another chat. Twice a week the bot offers one ability the person has not tried yet,
-- built by code from a fixed catalog (`agent/lib/coach-touches/feature-tips.ts`), with «Попробовать», «Не интересно»
-- and «Не присылать советы» under it. Once a day in the evening it sums up the day and asks what matters tomorrow.
--
-- `feature_uses` is what a person already tried, written by the `actions.requested` hook from the tools a trusted turn
-- called; `feature_tip_shows` is which tip a person saw and what they answered, so no tip comes twice. Both switches
-- are NULL by default, which means on: the owner wants them; `false` is the person's «не надо».
--
-- A new enum value cannot be used in the transaction that adds it, so the daily claim indexes are 196.
ALTER TYPE initiative_kind ADD VALUE 'feature_tip';
ALTER TYPE initiative_kind ADD VALUE 'evening_reflection';
ALTER TYPE proactive_delivery_source_kind ADD VALUE 'feature_tip';
ALTER TYPE proactive_delivery_source_kind ADD VALUE 'evening_reflection';

ALTER TABLE user_notification_settings
  ADD COLUMN feature_tips_enabled boolean,
  ADD COLUMN evening_reflection_enabled boolean;

CREATE TABLE feature_uses (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature text NOT NULL CHECK (feature ~ '^[a-z_]{1,40}$'),
  first_used_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  uses integer NOT NULL DEFAULT 1 CHECK (uses > 0),
  PRIMARY KEY (user_id, feature),
  CHECK (last_used_at >= first_used_at)
);

CREATE INDEX feature_uses_family ON feature_uses (family_id);

ALTER TABLE feature_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_uses FORCE ROW LEVEL SECURITY;
CREATE POLICY osinara_family_scope ON feature_uses
  USING (osinara_family_row_visible(family_id)) WITH CHECK (osinara_family_row_visible(family_id));

-- One row per person and tip: a tip is shown once. `delivery_ref` is the `initiative_messages` claim it went out
-- under; the «Попробовать» answer is recorded under the same reference so the next turn sees both messages.
CREATE TABLE feature_tip_shows (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tip_id text NOT NULL CHECK (tip_id ~ '^[a-z_]{1,40}$'),
  delivery_ref uuid NOT NULL,
  shown_at timestamptz NOT NULL DEFAULT now(),
  outcome text CHECK (outcome IN ('tried', 'dismissed')),
  answered_at timestamptz,
  UNIQUE (user_id, tip_id),
  CHECK ((outcome IS NULL) = (answered_at IS NULL))
);

CREATE INDEX feature_tip_shows_family ON feature_tip_shows (family_id);

ALTER TABLE feature_tip_shows ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_tip_shows FORCE ROW LEVEL SECURITY;
CREATE POLICY osinara_family_scope ON feature_tip_shows
  USING (osinara_family_row_visible(family_id)) WITH CHECK (osinara_family_row_visible(family_id));

-- «Попробовать» and «Не интересно» carry the tip's stable number; «Не присылать советы» and «Не писать вечером» switch
-- the presser's own setting. None of them acts on a task.
ALTER TABLE task_button_actions ADD COLUMN tip_number smallint CHECK (tip_number BETWEEN 1 AND 99);
ALTER TABLE task_button_actions DROP CONSTRAINT task_button_actions_action_check;
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_action_check CHECK (action IN (
  'complete', 'reopen', 'claim', 'accept', 'decline', 'all_tasks', 'digest_settings', 'digest_hour', 'digest_off',
  'share', 'unshare', 'default_family', 'default_personal', 'to_group',
  'help_start', 'postpone_week', 'cancel', 'keep', 'my_tasks', 'project_complete',
  'tip_try', 'tip_dismiss', 'tips_off', 'evening_off'
));
ALTER TABLE task_button_actions DROP CONSTRAINT task_button_actions_check1;
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_check1 CHECK (
  (action IN ('all_tasks', 'digest_settings', 'digest_hour', 'digest_off', 'default_family', 'default_personal', 'my_tasks',
              'tip_try', 'tip_dismiss', 'tips_off', 'evening_off'))
    = (task_id IS NULL)
);
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_tip_number
  CHECK ((action IN ('tip_try', 'tip_dismiss')) = (tip_number IS NOT NULL));
