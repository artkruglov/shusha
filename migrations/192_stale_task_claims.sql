-- Claims of the message about a task that has not moved (migration 191), and the buttons under it.
--
-- One such message per person and local day: several stuck tasks never arrive as a wall. A task is
-- written about once per version: a change of the task (new date, title) is a new situation, the same
-- version is never asked about twice.
CREATE UNIQUE INDEX initiative_messages_stale_task_daily
  ON initiative_messages(user_id, sent_on)
  WHERE kind = 'stale_task';

CREATE TABLE stale_task_claims (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES shared_tasks(id) ON DELETE CASCADE,
  task_version integer NOT NULL CHECK (task_version > 0),
  delivery_ref uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, task_id, task_version)
);

CREATE INDEX stale_task_claims_task ON stale_task_claims (task_id);

ALTER TABLE stale_task_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE stale_task_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY osinara_family_scope ON stale_task_claims
  USING (osinara_family_row_visible(family_id)) WITH CHECK (osinara_family_row_visible(family_id));

-- «Помоги начать» starts a turn, «Через неделю» moves the date, «Снять» cancels and «Оставить» rests the
-- task (migration 190). «Мои дела» under the family group overview shows the presser their family tasks
-- in a message only they see; it acts on no single task.
ALTER TABLE task_button_actions DROP CONSTRAINT task_button_actions_action_check;
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_action_check CHECK (action IN (
  'complete', 'reopen', 'claim', 'accept', 'decline', 'all_tasks', 'digest_settings', 'digest_hour', 'digest_off',
  'share', 'unshare', 'default_family', 'default_personal', 'to_group',
  'help_start', 'postpone_week', 'cancel', 'keep', 'my_tasks'
));
ALTER TABLE task_button_actions DROP CONSTRAINT task_button_actions_check1;
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_check1 CHECK (
  (action IN ('all_tasks', 'digest_settings', 'digest_hour', 'digest_off', 'default_family', 'default_personal', 'my_tasks'))
    = (task_id IS NULL)
);
