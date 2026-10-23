-- «В группу «…»» under the receipt of a personal record in a private chat (20 October 2026, GRP-09).
--
-- The owner decided a person may put a record into one of their ordinary groups from the private chat, but only into a
-- group whose chat they are in now. The button carries only `tb:<id>`; the group it moves to lives here, and the press
-- checks again in Telegram and PostgreSQL that the presser is in that group's chat and that the record is still theirs
-- alone. A group removed from the bot removes its buttons.
ALTER TABLE task_button_actions ADD COLUMN target_group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE;

ALTER TABLE task_button_actions DROP CONSTRAINT task_button_actions_action_check;
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_action_check CHECK (action IN (
  'complete', 'reopen', 'claim', 'accept', 'decline', 'all_tasks', 'digest_settings', 'digest_hour', 'digest_off',
  'share', 'unshare', 'default_family', 'default_personal', 'to_group'
));
ALTER TABLE task_button_actions ADD CONSTRAINT task_button_actions_target_group
  CHECK ((action = 'to_group') = (target_group_id IS NOT NULL));
