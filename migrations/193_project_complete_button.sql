-- «Завершить · проект» under a project whose tasks are all done, inside the task board (21 October 2026).
--
-- The team review found the board asking «Закрыть?» with no way to answer it in one tap. The button row holds the
-- project's id (a project is a `shared_tasks` row of kind project, migration 161) and its version; the press closes it
-- through the project repository, which refuses a project that still has open tasks.
ALTER TABLE task_button_actions DROP CONSTRAINT task_button_actions_action_check;
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_action_check CHECK (action IN (
  'complete', 'reopen', 'claim', 'accept', 'decline', 'all_tasks', 'digest_settings', 'digest_hour', 'digest_off',
  'share', 'unshare', 'default_family', 'default_personal', 'to_group',
  'help_start', 'postpone_week', 'cancel', 'keep', 'my_tasks', 'project_complete'
));
