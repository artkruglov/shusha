-- A group without a family (15 October 2026). The owner decided that any Telegram administrator may turn
-- the bot on in their own group, with no family, word or operator approval behind it; a ceiling on the
-- number of such groups and a monthly dollar budget per group guard the cost. Such a group is always
-- external: it gets its own `group` scope and never a family's memory, members or connections.
--
-- Until now every group belonged to a family (`telegram_groups.family_id NOT NULL`, migration 001) and
-- row-level security (migration 171) knew only families. Here the group and the tables a turn of it
-- writes (found by running a real mention through the handler against the test database: the group,
-- its conversation, participants, sessions, plus the audit) allow `family_id NULL`, and a second
-- permissive policy shows a row without a family only to the scope of its own group (`app.group_id`,
-- agent/lib/database-context.ts). The family policy is unchanged: `osinara_family_row_visible(NULL)` is
-- false outside the system scope, so no family ever sees such a row and a group scope sees no family.
--
-- Composite foreign keys `(group, family)` do nothing under MATCH SIMPLE when the family is NULL, so each
-- relaxed child gets a plain key on the group as well. Family profile rows (profile subjects, external
-- profile projection) are not created for a group without a family: there is no family profile to
-- project into, and the notice text speaks of a family owner.
--
-- A table that later relaxes family_id must get the same policy:
-- familyless-group-row-level-security.integration.test.ts fails otherwise.

ALTER TABLE telegram_groups
  ALTER COLUMN family_id DROP NOT NULL,
  ADD COLUMN enabled_by_telegram_user_id text CHECK (enabled_by_telegram_user_id ~ '^[1-9][0-9]{0,19}$'),
  ADD COLUMN monthly_budget_usd numeric(10, 2) CHECK (monthly_budget_usd > 0),
  ADD CONSTRAINT telegram_groups_familyless_shape CHECK (
    (family_id IS NULL) = (enabled_by_telegram_user_id IS NOT NULL)
    AND (enabled_by_telegram_user_id IS NULL) = (monthly_budget_usd IS NULL)
    AND (family_id IS NOT NULL OR (type = 'external' AND space_id IS NULL)));

ALTER TABLE application_conversations
  ALTER COLUMN family_id DROP NOT NULL,
  ADD CONSTRAINT application_conversations_familyless_shape CHECK (
    family_id IS NOT NULL OR (scope = 'group' AND space_id IS NULL)),
  ADD CONSTRAINT application_conversations_group_fkey
    FOREIGN KEY (telegram_group_id) REFERENCES telegram_groups(id) ON DELETE CASCADE,
  ADD CONSTRAINT application_conversations_id_scope_partition_key UNIQUE (id, scope, scope_partition_key);

ALTER TABLE conversation_participants
  ALTER COLUMN family_id DROP NOT NULL,
  ADD CONSTRAINT conversation_participants_familyless_shape CHECK (
    family_id IS NOT NULL OR (scope = 'group' AND space_id IS NULL)),
  ADD CONSTRAINT conversation_participants_conversation_partition_fkey
    FOREIGN KEY (conversation_id, scope, scope_partition_key)
    REFERENCES application_conversations(id, scope, scope_partition_key) ON DELETE CASCADE;

-- Deleting the group sets a session's group to NULL and retires it (retire_group_conversation_sessions);
-- the retired row stays for the retention worker, which runs in the system scope.
ALTER TABLE conversation_sessions
  ALTER COLUMN family_id DROP NOT NULL,
  ADD CONSTRAINT conversation_sessions_familyless_shape CHECK (
    family_id IS NOT NULL OR (space_id IS NULL AND (retired_at IS NOT NULL OR (scope = 'group' AND group_id IS NOT NULL))));

-- The group of an audit event is set only for a group without a family; family events keep their family.
ALTER TABLE audit_events
  ALTER COLUMN family_id DROP NOT NULL,
  ADD COLUMN group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  ADD CONSTRAINT audit_events_family_or_group CHECK ((family_id IS NULL) <> (group_id IS NULL));

CREATE INDEX audit_events_group_created_at ON audit_events (group_id, created_at DESC) WHERE group_id IS NOT NULL;

CREATE OR REPLACE FUNCTION create_external_profile_projection_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  policy_notice text := 'Проекция сведений из этой внешней группы в личный профиль участника отключена. Владелец семьи может изменить политику только с явным уведомлением группы.';
BEGIN
  IF NEW.type = 'external' AND NEW.family_id IS NOT NULL THEN
    INSERT INTO external_profile_projection_policies (group_id, family_id)
    VALUES (NEW.id, NEW.family_id);
    INSERT INTO external_profile_projection_notices
      (group_id, family_id, policy_version, enabled, notice_text)
    VALUES (NEW.id, NEW.family_id, 1, false, policy_notice);
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION sync_profile_subject_from_participant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conversation_scope memory_scope;
BEGIN
  IF NEW.family_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT scope INTO conversation_scope
  FROM application_conversations WHERE id = NEW.conversation_id;

  IF conversation_scope = 'group' THEN
    INSERT INTO profile_subjects
      (conversation_id, family_id, subject_participant_id, subject_conversation_id,
       display_label_snapshot, last_verified_at)
    VALUES (
      NEW.conversation_id,
      NEW.family_id,
      NEW.id,
      NEW.conversation_id,
      coalesce(NEW.display_name_snapshot, 'Участник Telegram'),
      NEW.last_observed_at
    )
    ON CONFLICT (conversation_id, subject_user_id, subject_participant_id)
    DO UPDATE SET
      display_label_snapshot = EXCLUDED.display_label_snapshot,
      last_verified_at = greatest(profile_subjects.last_verified_at, EXCLUDED.last_verified_at),
      dormant_at = NULL,
      updated_at = now();
  ELSIF NEW.linked_user_id IS NOT NULL THEN
    INSERT INTO profile_subjects
      (conversation_id, family_id, subject_user_id, display_label_snapshot, last_verified_at)
    VALUES (
      NEW.conversation_id,
      NEW.family_id,
      NEW.linked_user_id,
      coalesce(NEW.display_name_snapshot, 'Участник семьи'),
      NEW.last_observed_at
    )
    ON CONFLICT (conversation_id, subject_user_id, subject_participant_id)
    DO UPDATE SET
      display_label_snapshot = EXCLUDED.display_label_snapshot,
      last_verified_at = greatest(profile_subjects.last_verified_at, EXCLUDED.last_verified_at),
      dormant_at = NULL,
      updated_at = now();
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION osinara_familyless_group_visible(row_group uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT row_group = nullif(current_setting('app.group_id', true), '')::uuid
$$;

CREATE POLICY osinara_group_scope ON telegram_groups
  USING (family_id IS NULL AND osinara_familyless_group_visible(id))
  WITH CHECK (family_id IS NULL AND osinara_familyless_group_visible(id));
CREATE POLICY osinara_group_scope ON application_conversations
  USING (family_id IS NULL AND osinara_familyless_group_visible(telegram_group_id))
  WITH CHECK (family_id IS NULL AND osinara_familyless_group_visible(telegram_group_id));
-- A participant of a group conversation is partitioned by the group (application_conversations_partition_shape).
CREATE POLICY osinara_group_scope ON conversation_participants
  USING (family_id IS NULL AND scope = 'group' AND osinara_familyless_group_visible(scope_partition_key))
  WITH CHECK (family_id IS NULL AND scope = 'group' AND osinara_familyless_group_visible(scope_partition_key));
CREATE POLICY osinara_group_scope ON conversation_sessions
  USING (family_id IS NULL AND osinara_familyless_group_visible(group_id))
  WITH CHECK (family_id IS NULL AND osinara_familyless_group_visible(group_id));
CREATE POLICY osinara_group_scope ON audit_events
  USING (family_id IS NULL AND osinara_familyless_group_visible(group_id))
  WITH CHECK (family_id IS NULL AND osinara_familyless_group_visible(group_id));
