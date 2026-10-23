-- Who sees a new task written in a private chat (19 October 2026, onboarding v3).
--
-- A second adult asked three times for everything to be shared, and the bot kept writing her tasks as personal: the
-- first adult never saw them. A person now chooses once, under the receipt of their first task: «Для семьи» or
-- «Только мне». NULL means not asked yet; the task is then written personal, as before, and the question is offered.
-- An assignment to another adult is shared whatever this says: the one asked has to see it.
ALTER TABLE user_notification_settings
  ADD COLUMN default_task_visibility text CHECK (default_task_visibility IN ('family', 'personal'));

-- The receipt's buttons: make one task shared or personal, and the one-time choice of the default.
ALTER TABLE task_button_actions DROP CONSTRAINT task_button_actions_action_check;
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_action_check CHECK (action IN (
  'complete', 'reopen', 'claim', 'accept', 'decline', 'all_tasks', 'digest_settings', 'digest_hour', 'digest_off',
  'share', 'unshare', 'default_family', 'default_personal'
));
ALTER TABLE task_button_actions DROP CONSTRAINT task_button_actions_check1;
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_check1 CHECK (
  (action IN ('all_tasks', 'digest_settings', 'digest_hour', 'digest_off', 'default_family', 'default_personal')) = (task_id IS NULL)
);
