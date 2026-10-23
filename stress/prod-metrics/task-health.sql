-- Task health of production, counts only: no message text, titles or ids leave the database.
-- Run read-only on the host (the file is uploaded, quoting inside `fly ssh -C` breaks easily):
--   fly ssh sftp put stress/prod-metrics/task-health.sql /tmp/task-health.sql -a <fly-app>
--   fly ssh console -a <fly-app> -C "sh -c 'docker exec -i osinara-production-postgres-1 psql -U osinara -d osinara -P pager=off < /tmp/task-health.sql; rm -f /tmp/task-health.sql'"
-- 20 October 2026: a project is a `shared_tasks` row with kind 'project' (migration 161); counting it as a task
-- turned migration-made project twins into "13% duplicate tasks". Every query below names its kinds.
BEGIN READ ONLY;
\echo == people and families with tasks, last 30 days
SELECT count(DISTINCT family_id) families, count(DISTINCT creator_telegram_id) creators
  FROM shared_tasks WHERE kind <> 'project' AND created_at > now() - interval '30 days';
\echo == open items by kind and age
SELECT kind, CASE WHEN created_at > now() - interval '7 days' THEN '<7d' WHEN created_at > now() - interval '21 days' THEN '7-21d' ELSE '>21d' END age, count(*)
  FROM shared_tasks WHERE status IN ('accepted', 'proposed') GROUP BY 1, 2 ORDER BY 1, 2;
\echo == created and completed tasks per week
SELECT w, sum(created) created, sum(completed) completed FROM (
  SELECT date_trunc('week', created_at)::date w, 1 created, 0 completed FROM shared_tasks WHERE kind IN ('task', 'idea')
  UNION ALL SELECT date_trunc('week', created_at)::date, 0, 1 FROM shared_task_versions WHERE action = 'complete') s
  GROUP BY w ORDER BY w;
\echo == duplicate open tasks (same normalized title in one family), any scope
SELECT count(*) groups, coalesce(sum(n), 0) tasks FROM (
  SELECT count(*) n FROM shared_tasks WHERE status IN ('accepted', 'proposed') AND kind IN ('task', 'idea')
   GROUP BY family_id, lower(regexp_replace(title, '\W', '', 'g')) HAVING count(*) > 1) d;
\echo == open projects sharing a name: same scope / across scopes
SELECT count(*) FILTER (WHERE scopes = 1) same_scope, count(*) FILTER (WHERE scopes > 1) across_scopes FROM (
  SELECT count(DISTINCT scope) scopes, count(*) n FROM shared_tasks WHERE kind = 'project' AND status = 'accepted'
   GROUP BY family_id, lower(title) HAVING count(*) > 1) p;
\echo == reopened after completion, last 30 days
SELECT count(*) FROM shared_task_versions WHERE action = 'reopen' AND created_at > now() - interval '30 days';
\echo == overdue open tasks: days overdue and how many proactive messages showed them since the due date
SELECT (now()::date - coalesce(t.due_on, (t.due_at AT TIME ZONE 'Europe/Moscow')::date)) overdue_days, count(d.id) times_shown
  FROM shared_tasks t LEFT JOIN proactive_deliveries d ON d.family_id = t.family_id
   AND d.content_text LIKE '%' || left(t.title, 40) || '%' AND d.delivered_at > coalesce(t.due_on::timestamptz, t.due_at)
 WHERE t.status IN ('accepted', 'proposed') AND t.kind = 'task'
   AND coalesce(t.due_on, (t.due_at AT TIME ZONE 'Europe/Moscow')::date) < now()::date
 GROUP BY t.id, 1 ORDER BY 1 DESC;
\echo == task buttons shown and pressed, last 30 days
SELECT action, count(*) shown, count(*) FILTER (WHERE replaced_by IS NOT NULL OR removed_at IS NOT NULL) pressed
  FROM task_button_actions WHERE created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1;
\echo == voice messages and failures, last 30 days
SELECT count(*) voices, count(*) FILTER (WHERE voice_transcript IS NULL) without_transcript,
       string_agg(DISTINCT last_error_code, ',') FILTER (WHERE voice_transcript IS NULL) errors
  FROM telegram_ingress_updates WHERE voice_file_id IS NOT NULL AND received_at > now() - interval '30 days';
\echo == failed ingress updates, last 30 days
SELECT last_error_code, count(*) FROM telegram_ingress_updates WHERE status = 'failed' AND received_at > now() - interval '30 days' GROUP BY 1;
ROLLBACK;
