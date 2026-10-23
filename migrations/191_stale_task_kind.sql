-- One message about a task that has not moved, instead of repeating it every morning (21 October 2026).
--
-- After three mornings without a change an overdue task leaves the overview (migration 190), and the
-- bot writes once: «"…" не менялось с …. Что с ним сделаем?» with «Помоги начать», «Через неделю»,
-- «Снять» and «Оставить» (docs/design/task-lists-v3.ru.md). It is a conversation the bot starts, so it
-- is counted in `initiative_messages` and recorded in the private chat's deliveries like the others.
--
-- A new enum value cannot be used in the transaction that adds it, so the claims live in 192.
ALTER TYPE initiative_kind ADD VALUE 'stale_task';
ALTER TYPE proactive_delivery_source_kind ADD VALUE 'stale_task';
