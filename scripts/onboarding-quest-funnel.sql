-- «Знакомство с Юной»: воронка первых шагов по каждому человеку новых семей (docs/service/pm/onboarding-quest.ru.md).
-- Только чтение и только факты из базы: без текста переписки, из имён только display_name. Ошибки AGENT_*FAILED
-- живут в логах агента, не здесь. Шаг засчитан, если он отмечен квестом (`onboarding_quest_marks`, миграция 197) или
-- его признак виден сейчас; признаки те же, что в `agent/lib/onboarding-quest/quest-repository.ts`. Какие шаги есть
-- на сервере (картинки, семейный чат), база не знает: отчёт показывает все восемь, «текущий» шаг — первый
-- несделанный из них. Приглашение и семейный чат — шаги владельца, участнику они не считаются, а общее дело в
-- чате считается участнику, только когда у семьи есть семейный чат.
-- Запуск на хосте (файл загружается, кавычки внутри `fly ssh -C` ломаются):
--   fly ssh sftp put scripts/onboarding-quest-funnel.sql /tmp/quest-funnel.sql -a <fly-app>
--   fly ssh console -a <fly-app> -C "sh -c 'docker exec -i osinara-production-postgres-1 psql -U osinara -d osinara -P pager=off < /tmp/quest-funnel.sql; rm -f /tmp/quest-funnel.sql'"
-- Окно: семьи, где кто-то вошёл за последние 30 дней (`\set days 30` перед запуском меняет его).
\if :{?days}
\else
  \set days 30
\endif
-- The temporary view lives only in this transaction and writes no table; right after it the transaction turns read only,
-- and ROLLBACK at the end drops it.
BEGIN;
CREATE TEMP VIEW quest_done AS
WITH people AS (
  SELECT membership.family_id, membership.user_id, membership.role::text AS role, membership.created_at AS joined_at,
         person.display_name, person.telegram_user_id,
         COALESCE(settings.feature_tips_enabled = false, false) AS tips_off
    FROM family_memberships AS membership
    JOIN users AS person ON person.id = membership.user_id
    LEFT JOIN user_notification_settings AS settings ON settings.user_id = person.id
   WHERE membership.family_id IN (SELECT family_id FROM family_memberships
                                   WHERE created_at > now() - make_interval(days => :days))
), family AS (
  SELECT families.id AS family_id,
         (SELECT count(*) FROM family_memberships AS m WHERE m.family_id = families.id) AS members,
         (SELECT count(*) FROM family_memberships AS m WHERE m.family_id = families.id AND m.relation IS DISTINCT FROM 'child') AS adults,
         EXISTS (SELECT 1 FROM telegram_groups AS g WHERE g.family_id = families.id AND g.type = 'family_private') AS family_group
    FROM families WHERE families.id IN (SELECT family_id FROM people)
), own_updates AS (
  SELECT update_row.payload->'message'->'from'->>'id' AS telegram_user_id, update_row.received_at,
         update_row.payload->'message'->'chat'->>'type' = 'private' AS private,
         update_row.payload->'message' ? 'photo' AS photo, update_row.voice_transcript IS NOT NULL AS voice
    FROM telegram_ingress_updates AS update_row
   WHERE update_row.payload->'message'->'from'->>'id' IN (SELECT telegram_user_id FROM people)
), steps AS (
  SELECT people.*, family.members, family.adults, family.family_group,
         ARRAY(SELECT mark FROM onboarding_quest_marks AS q WHERE q.user_id = people.user_id) AS marks,
         ARRAY(SELECT feature FROM feature_uses AS f WHERE f.user_id = people.user_id) AS used,
         EXISTS (SELECT 1 FROM own_updates AS u JOIN shared_tasks AS t ON t.family_id = people.family_id
                  AND t.creator_telegram_id = people.telegram_user_id
                  AND t.created_at BETWEEN u.received_at AND u.received_at + interval '15 minutes'
                  WHERE u.telegram_user_id = people.telegram_user_id AND u.private AND u.voice) AS voice_task,
         EXISTS (SELECT 1 FROM own_updates AS u WHERE u.telegram_user_id = people.telegram_user_id AND u.private AND u.photo) AS photo_sent,
         (SELECT max(u.received_at) FROM own_updates AS u WHERE u.telegram_user_id = people.telegram_user_id) AS last_message_at
    FROM people JOIN family USING (family_id)
), done AS (
  SELECT steps.*, ARRAY_REMOVE(ARRAY[
           CASE WHEN 'voice' = ANY(marks) OR voice_task THEN 'voice' END,
           CASE WHEN role = 'owner' AND ('family' = ANY(marks) OR adults >= 2) THEN 'family' END,
           CASE WHEN role = 'owner' AND ('family_chat' = ANY(marks) OR family_group) THEN 'family_chat' END,
           CASE WHEN 'group_task' = ANY(marks) OR 'group_task' = ANY(used) THEN 'group_task' END,
           CASE WHEN 'photo' = ANY(marks) OR 'photo' = ANY(used) OR photo_sent THEN 'photo' END,
           CASE WHEN 'image' = ANY(marks) OR 'image' = ANY(used) THEN 'image' END,
           CASE WHEN 'web_search' = ANY(marks) OR 'web_search' = ANY(used) THEN 'web_search' END,
           CASE WHEN 'shopping' = ANY(marks) OR 'shopping' = ANY(used) OR 'grocery' = ANY(used) THEN 'shopping' END
         ], NULL) AS steps_done
    FROM steps
)
SELECT * FROM done;
SET TRANSACTION READ ONLY;
\echo == first steps by person of new families
SELECT left(family_id::text, 8) AS family, display_name AS person, role,
       (now()::date - joined_at::date) AS days_in_family, members, adults, family_group,
       cardinality(steps_done) || ' из ' || CASE WHEN role = 'owner' THEN 8 WHEN family_group THEN 6 ELSE 5 END AS progress,
       array_to_string(steps_done, ', ') AS steps_done,
       CASE WHEN 'final' = ANY(marks) THEN 'финал'
            WHEN tips_off THEN 'выключил подсказки'
            ELSE (SELECT step FROM unnest(CASE WHEN role = 'owner'
                    THEN ARRAY['voice', 'family', 'family_chat', 'group_task', 'photo', 'image', 'web_search', 'shopping']
                    WHEN family_group THEN ARRAY['voice', 'group_task', 'photo', 'image', 'web_search', 'shopping']
                    ELSE ARRAY['voice', 'photo', 'image', 'web_search', 'shopping'] END)
                    WITH ORDINALITY AS all_steps(step, position)
                   WHERE step <> ALL(steps_done) ORDER BY position LIMIT 1) END AS current_step,
       array_to_string(ARRAY(SELECT mark FROM unnest(marks) AS mark WHERE mark LIKE 'touch_%' ORDER BY mark), ', ') AS touches,
       to_char(last_message_at, 'YYYY-MM-DD HH24:MI') AS last_message_at
  FROM quest_done
 ORDER BY joined_at DESC, family, role DESC;
\echo == step reach: how many people of these families did each step
SELECT step, count(*) FILTER (WHERE step = ANY(steps_done)) AS done, count(*) AS people
  FROM quest_done CROSS JOIN unnest(ARRAY['voice', 'family', 'family_chat', 'group_task', 'photo', 'image', 'web_search', 'shopping'])
       WITH ORDINALITY AS all_steps(step, position)
 WHERE role = 'owner' OR step NOT IN ('family', 'family_chat', 'group_task') OR (step = 'group_task' AND family_group)
 GROUP BY step, position ORDER BY position;
ROLLBACK;
