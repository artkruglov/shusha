-- The board a «✓», «Беру» or «Завершить» was drawn in, so that a press redraws the same board (21 October 2026).
--
-- The code review found that a press redrew the whole open list: «что на сегодня?» showed three tasks, one tap on ✓
-- turned the message into all fifty-seven. A button of a board now keeps the board's query: the list filters a turn
-- asked for (view, list, life area, care area, status) or the morning overview's «Все дела». It carries no task data and
-- no identity; the press still reads the board under the presser's live rights.
ALTER TABLE task_button_actions ADD COLUMN board_query jsonb CHECK (board_query IS NULL OR jsonb_typeof(board_query) = 'object');
