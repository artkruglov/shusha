-- Which tasks the morning overview showed, and which the person chose to leave alone (21 October 2026).
--
-- Four overdue tasks were shown 26-31 mornings in a row and «✓» under them was never pressed. The owner
-- decided the overview should not keep stating an overdue task: after three mornings without a change
-- it leaves the overview, and one message offers help instead (docs/design/task-lists-v3.ru.md).
-- A show is counted at the task's version: any change of the task (new date, title, assignee) starts
-- the count again. «Оставить» under that message rests the task at its version, so the same change
-- brings it back. Rows of a deleted task go with it.
CREATE TABLE task_overview_shows (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES shared_tasks(id) ON DELETE CASCADE,
  task_version integer NOT NULL CHECK (task_version > 0),
  shown_on date NOT NULL,
  PRIMARY KEY (user_id, task_id, shown_on)
);

CREATE INDEX task_overview_shows_task ON task_overview_shows (task_id);
CREATE INDEX task_overview_shows_shown_on ON task_overview_shows (shown_on);

CREATE TABLE task_overview_rests (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES shared_tasks(id) ON DELETE CASCADE,
  task_version integer NOT NULL CHECK (task_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, task_id)
);

CREATE INDEX task_overview_rests_task ON task_overview_rests (task_id);

ALTER TABLE task_overview_shows ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_overview_shows FORCE ROW LEVEL SECURITY;
CREATE POLICY osinara_family_scope ON task_overview_shows
  USING (osinara_family_row_visible(family_id)) WITH CHECK (osinara_family_row_visible(family_id));

ALTER TABLE task_overview_rests ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_overview_rests FORCE ROW LEVEL SECURITY;
CREATE POLICY osinara_family_scope ON task_overview_rests
  USING (osinara_family_row_visible(family_id)) WITH CHECK (osinara_family_row_visible(family_id));
