/**
 * Доска дел хода, которую канал сам прикладывает к ответу.
 *
 * Exports:
 * - `markTurnBoard`, `takeTurnBoard`: доска на ход (ключ сессия и ход Eve), снимается один раз.
 *
 * 21 октября 2026 на «скинь список» модель пересказала доску своими словами: 57 дел, до девяти в
 * одной строке. Правило «отправь board как есть» жило только в промпте. Теперь `manage_shared_tasks`
 * с `show` кладёт готовую доску сюда, модели отдаёт лишь пометку, а канал отправляет доску отдельным
 * сообщением сразу после ответа: так нажатие «✓» в ней перерисовывает только доску.
 *
 * Состояние в памяти процесса, как у флага keep-open: перезапуск теряет доску одного хода, и тогда
 * человек получает только фразу модели. Запас ограничен, лишние ключи не копятся.
 */
export interface TurnBoard {
  /** Rich Markdown with its buttons; the channel sends it as its own message after the answer. */
  readonly markdown: string;
}

const MAX_BOARDS = 500;
const boards = new Map<string, TurnBoard>();

/** Повторный вызов в том же ходе заменяет доску: показывается последнее прочитанное. */
export function markTurnBoard(key: string, board: TurnBoard): void {
  boards.delete(key);
  if (boards.size >= MAX_BOARDS) boards.delete(boards.keys().next().value as string);
  boards.set(key, board);
}

export function takeTurnBoard(key: string): TurnBoard | null {
  const board = boards.get(key) ?? null;
  boards.delete(key);
  return board;
}
