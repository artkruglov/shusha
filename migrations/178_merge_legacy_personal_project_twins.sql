-- Personal project twins of a family still in the legacy mode (16 October 2026).
--
-- Migration 161 gave every task list a project per space, and a personal list that existed before the
-- move to areas got the author's personal space. A turn in the legacy mode has no area, so the project
-- resolver looked for the name with `space_id IS NULL`, did not see the old project and created a second
-- one (prod 15 October 2026: «Встречи», «Работа», «Работа · Яндекс», «Т-Банк» twice each). The morning
-- board showed both, and a task could land in either. The resolver now finds the old project
-- (agent/lib/projects/project-resolver.ts); this folds the twins already made into it.
--
-- Only personal projects of one author without a group, one with the author's personal space and one
-- without any: the same person's one list split by a technical boundary. Family, group and other
-- people's projects with the same name are different things and stay. The space of a task may only go
-- from NULL to a space (guard_space_record_boundary), so the projectless-space twin folds into the old
-- one, and its tasks take the old project's space with the project. Every moved task gets a version row,
-- as a merge by hand does (agent/lib/projects/project-moves.ts).

CREATE TEMPORARY TABLE legacy_project_twins ON COMMIT DROP AS
SELECT twin.id AS twin_id, twin.family_id, twin.creator_telegram_id, canon.id AS canon_id,
       canon.space_id AS canon_space, canon.title AS canon_title
  FROM shared_tasks twin
  JOIN family_space_runtime runtime ON runtime.family_id = twin.family_id AND runtime.mode = 'legacy'
  JOIN LATERAL (
    SELECT c.id, c.space_id, c.title
      FROM shared_tasks c
      JOIN spaces s ON s.id = c.space_id AND s.family_id = c.family_id AND s.kind = 'personal'
      JOIN users owner ON owner.id = s.owner_user_id AND owner.telegram_user_id = c.creator_telegram_id
     WHERE c.kind = 'project' AND c.status = 'accepted' AND c.family_id = twin.family_id
       AND c.scope = 'personal' AND c.group_id IS NULL
       AND c.creator_telegram_id = twin.creator_telegram_id
       AND task_project_key(c.title) = task_project_key(twin.title)
     ORDER BY c.created_at, c.id
     LIMIT 1
  ) canon ON true
 WHERE twin.kind = 'project' AND twin.status = 'accepted' AND twin.scope = 'personal'
   AND twin.group_id IS NULL AND twin.space_id IS NULL;

INSERT INTO shared_task_versions (task_id, version, actor_telegram_id, action, previous_record)
SELECT t.id, t.version + 1, p.creator_telegram_id, 'project_merge', to_jsonb(t)
  FROM shared_tasks t JOIN legacy_project_twins p ON t.project_id = p.twin_id
ON CONFLICT (task_id, version) DO NOTHING;

UPDATE shared_tasks t
   SET project_id = p.canon_id, list_name = p.canon_title, space_id = p.canon_space,
       version = version + 1, updated_at = now()
  FROM legacy_project_twins p
 WHERE t.project_id = p.twin_id;

-- What the twin knew and the old project did not (sphere, intended outcome) stays with the project.
UPDATE shared_tasks canon
   SET life_area = COALESCE(canon.life_area, twin.life_area),
       details = COALESCE(canon.details, twin.details)
  FROM legacy_project_twins p JOIN shared_tasks twin ON twin.id = p.twin_id
 WHERE canon.id = p.canon_id;

INSERT INTO shared_task_versions (task_id, version, actor_telegram_id, action, previous_record)
SELECT twin.id, twin.version + 1, p.creator_telegram_id, 'project_merge', to_jsonb(twin)
  FROM shared_tasks twin JOIN legacy_project_twins p ON twin.id = p.twin_id
ON CONFLICT (task_id, version) DO NOTHING;

UPDATE shared_tasks twin
   SET status = 'cancelled',
       details = left(concat_ws(E'\n', twin.details, 'Объединён с проектом «' || p.canon_title || '»'), 1000),
       version = version + 1, updated_at = now()
  FROM legacy_project_twins p
 WHERE twin.id = p.twin_id;

INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
SELECT family_id, 'project.legacy_twin_merged', canon_id, jsonb_build_object('twin', twin_id)
  FROM legacy_project_twins;
