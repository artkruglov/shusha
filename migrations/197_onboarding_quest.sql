-- «Знакомство с Юной»: the eight first steps of a new person (docs/service/pm/onboarding-quest.ru.md, 23 October 2026).
--
-- Whether a step is done is read from data that already exists (`agent/lib/onboarding-quest/quest-repository.ts`).
-- This table only remembers what the quest already said and did, so nothing is said twice: a step marked here was
-- already counted (its «Получилось ✓» went out or it was done before the person started), `start` is the first look
-- at the person, `touch_1`/`touch_3`/`touch_7` the idle touches of those days (under the `initiative_messages` claim
-- in `delivery_ref`), `final` the closing «Вы попробовали всё». A mark also keeps a step done after its source rows
-- expire (raw updates live 30 days, task buttons 7). Marks, step keys and times only; no content.
CREATE TABLE onboarding_quest_marks (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mark text NOT NULL CHECK (mark ~ '^[a-z0-9_]{1,40}$'),
  delivery_ref uuid,
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mark)
);

CREATE INDEX onboarding_quest_marks_family ON onboarding_quest_marks (family_id);

ALTER TABLE onboarding_quest_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_quest_marks FORCE ROW LEVEL SECURITY;
CREATE POLICY osinara_family_scope ON onboarding_quest_marks
  USING (osinara_family_row_visible(family_id)) WITH CHECK (osinara_family_row_visible(family_id));

-- «Попробовать» under a step card carries the step's number in `tip_number`; «Позже» carries nothing. «Хватит
-- подсказок» is the existing `tips_off`: it switches off the feature tips, and the quest with them.
ALTER TABLE task_button_actions DROP CONSTRAINT task_button_actions_action_check;
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_action_check CHECK (action IN (
  'complete', 'reopen', 'claim', 'accept', 'decline', 'all_tasks', 'digest_settings', 'digest_hour', 'digest_off',
  'share', 'unshare', 'default_family', 'default_personal', 'to_group',
  'help_start', 'postpone_week', 'cancel', 'keep', 'my_tasks', 'project_complete',
  'tip_try', 'tip_dismiss', 'tips_off', 'evening_off', 'quest_try', 'quest_later'
));
ALTER TABLE task_button_actions DROP CONSTRAINT task_button_actions_check1;
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_check1 CHECK (
  (action IN ('all_tasks', 'digest_settings', 'digest_hour', 'digest_off', 'default_family', 'default_personal', 'my_tasks',
              'tip_try', 'tip_dismiss', 'tips_off', 'evening_off', 'quest_try', 'quest_later'))
    = (task_id IS NULL)
);
ALTER TABLE task_button_actions DROP CONSTRAINT task_button_actions_tip_number;
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_tip_number
  CHECK ((action IN ('tip_try', 'tip_dismiss', 'quest_try')) = (tip_number IS NOT NULL));
