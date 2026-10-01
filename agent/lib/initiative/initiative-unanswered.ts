/**
 * Сколько начатых ботом разговоров человек оставил без ответа.
 *
 * Экспорт:
 * - `INITIATIVE_UNANSWERED_WINDOW_DAYS`: как долго молчание считается.
 * - `unansweredCountSql`: SQL-выражение счёта для запросов инициативы, чтобы у обзора, коуча,
 *   уведомлений и общего правила не разошлись копии.
 *
 * Пауза после трёх молчаний защищает человека от рассылки, но раньше она снималась только его
 * собственным словом в личке. Кто три раза не ответил и месяц не писал боту, оставался без
 * инициативы навсегда, хотя молчание могло значить отпуск, потерянное сообщение или уход в
 * группу (28 сентября 2026: владелец жаловался, что бот больше не спрашивает и не пингует).
 * Теперь считается только молчание последних двух недель: старое забывается, и бот получает
 * право один раз спросить снова, не дожидаясь человека. Свежее молчание держит паузу как прежде.
 */
export const INITIATIVE_UNANSWERED_WINDOW_DAYS = 14;

/** `personColumn` это колонка id человека, `nowParam` номер параметра момента времени, например `$1`. */
export function unansweredCountSql(personColumn: string, nowParam: string): string {
  return `(SELECT count(*) FROM initiative_messages AS sent
                WHERE sent.user_id = ${personColumn} AND sent.answered_at IS NULL
                  AND sent.sent_at > ${nowParam}::timestamptz
                      - make_interval(days => ${INITIATIVE_UNANSWERED_WINDOW_DAYS}))::text`;
}
