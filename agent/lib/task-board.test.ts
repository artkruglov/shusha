import { describe, expect, it } from "vitest";

import {
  formatTaskBoard, TASK_BOARD_MAX_CHARACTERS, taskBoardReply, type BoardTask,
} from "./task-board.js";
import { formatTelegramFinalPresentation } from "./telegram-final-presentation.js";

const NOW = new Date("2026-09-22T06:00:00Z");
const task = (title: string, extra: Partial<BoardTask> = {}): BoardTask => ({
  dueAt: null, dueOn: null, kind: "task", listName: null, source: "Личное", status: "accepted", title, ...extra,
});

describe("task board", () => {
  it("puts every open task in front of the person, overdue first, then by list", () => {
    const board = formatTaskBoard({
      now: NOW, style: "plain", timezone: "Europe/Moscow",
      tasks: [
        task("Договориться с мастером", { dueOn: "2026-09-15", listName: "Встречи" }),
        task("Встреча в Zoom", { dueAt: "2026-09-16T06:00:00Z", listName: "Встречи" }),
        task("Позвонить в банк", { dueOn: "2026-09-22", listName: "Дом" }),
        task("Продвинуться по продаже", { listName: "Работа" }),
        task("Написать отзыв", { listName: "Работа" }),
        task("Отвезти машину", { listName: "Дом" }),
        task("Найти мастеров для штор", { listName: "Дом", source: "Семья", status: "open" }),
        task("Венчур", { kind: "idea" }),
        task("Уже сделано", { status: "completed", listName: "Работа" }),
      ],
      waiting: [task("Саша забирает посылку", { assignee: "Саша", status: "proposed" })],
    })!;

    expect(board.split("\n\n")).toEqual([
      "⚠️ Просрочено · 2\n• Договориться с мастером — срок 15.09\n• Встреча в Zoom — срок 16.09",
      "Сегодня · 1\n• Позвонить в банк",
      "Ничьи · 1\n• Найти мастеров для штор · Дом\nНикто не взял. Скажи «беру» или назови, кому.",
      "Дом · 1\n• Отвезти машину",
      "Работа · 2\n• Продвинуться по продаже\n• Написать отзыв",
      "Жду ответа · 1\n• Саша забирает посылку · ждёт согласия: Саша",
      "Когда-нибудь · 1\n• Венчур",
      "Открытых дел: 7",
    ]);
  });

  it("shows what nobody took and what waits for someone's yes apart from tasks somebody is doing", () => {
    // Прод 1 октября 2026: 19 ничьих дел висели среди живых, и «записано» читалось как «делается».
    const board = formatTaskBoard({
      now: NOW, style: "plain", timezone: "UTC",
      tasks: [
        task("Заказать матрас", { listName: "Переезд", status: "open" }),
        task("Выкинуть мусор", { status: "open" }),
        task("Купить щёточку", { assignee: "Юля", listName: "Дом", status: "proposed" }),
        task("Отвезти машину", { listName: "Дом" }),
        task("Старое ничьё", { dueOn: "2026-09-15", status: "open" }),
      ],
    })!;

    expect(board).toContain("Ничьи · 2\n• Заказать матрас · Переезд\n• Выкинуть мусор\nНикто не взял. Скажи «беру» или назови, кому.");
    expect(board).toContain("Ждут согласия · 1\n• Купить щёточку — Юля");
    expect(board).toContain("Дом · 1\n• Отвезти машину");
    // С просроченным сроком ничьё дело идёт в просроченные и помечено, чтобы не потеряться.
    expect(board).toContain("⚠️ Просрочено · 1\n• Старое ничьё — срок 15.09 · ничьё");
    expect(board.indexOf("Ничьи")).toBeLessThan(board.indexOf("Дом · 1"));
  });

  it("shows up to ten unowned tasks, because they are what needs sorting", () => {
    const tasks = Array.from({ length: 12 }, (_, index) => task(`Ничьё ${index + 1}`, { status: "open" }));
    const board = formatTaskBoard({ now: NOW, style: "plain", timezone: "UTC", tasks })!;

    expect(board).toContain("• Ничьё 10\n…и ещё 2\nНикто не взял.");
  });

  it("names the project even when the task has a life area, and shows its progress", () => {
    // Прод 1 октября 2026: у личных дел «Переезд» стояла сфера «Дом и забота», заголовок брал сферу, и
    // проект на доске не было видно вовсе.
    const board = formatTaskBoard({
      now: NOW, style: "plain", timezone: "UTC",
      projects: [{ completed: 3, hasNextStep: true, id: "p1", open: 2, source: "Личное", status: "accepted", title: "Переезд", total: 5 }],
      tasks: [
        task("Заказать матрас", { lifeArea: "home", listName: "Переезд", projectId: "p1" }),
        task("Сдать ключи", { lifeArea: "home", listName: "Переезд", projectId: "p1" }),
        task("Записаться на йогу", { lifeArea: "self" }),
      ],
    })!;

    expect(board).toContain("Переезд (Дом и забота) · 2 · сделано 3 из 5\n• Заказать матрас\n• Сдать ключи");
    // Без проекта заголовком остаётся сфера, как раньше.
    expect(board).toContain("Для себя · 1\n• Записаться на йогу");
  });

  it("keeps progress off a small or untouched project", () => {
    const board = formatTaskBoard({
      now: NOW, style: "plain", timezone: "UTC",
      projects: [
        { completed: 0, hasNextStep: true, id: "a", open: 3, source: "Личное", status: "accepted", title: "Ремонт", total: 3 },
        { completed: 1, hasNextStep: true, id: "b", open: 1, source: "Личное", status: "accepted", title: "Отпуск", total: 2 },
      ],
      tasks: [
        task("Один", { listName: "Ремонт", projectId: "a" }), task("Два", { listName: "Ремонт", projectId: "a" }),
        task("Три", { listName: "Ремонт", projectId: "a" }), task("Билеты", { listName: "Отпуск", projectId: "b" }),
      ],
    })!;

    expect(board).toContain("Ремонт · 3\n");
    expect(board).toContain("Отпуск · 1\n");
  });

  it("lists projects with no next step and projects where everything is done, each with its way out", () => {
    const board = formatTaskBoard({
      now: NOW, style: "plain", timezone: "UTC",
      projects: [
        { completed: 0, hasNextStep: false, id: "x", open: 0, source: "Семья", status: "accepted", title: "Отпуск в августе", total: 0 },
        { completed: 4, hasNextStep: false, id: "y", open: 0, source: "Личное", status: "accepted", title: "Переезд", total: 4 },
        { completed: 1, hasNextStep: true, id: "z", open: 2, source: "Личное", status: "accepted", title: "Ремонт", total: 3 },
      ],
      tasks: [task("Позвонить мастеру", { listName: "Ремонт", projectId: "z" })],
    })!;

    expect(board).toContain("Проекты без шага · 1\n• Отпуск в августе\nСкажи первый шаг.");
    expect(board).toContain("Проекты, где всё сделано · 1\n• Переезд\nЗакрыть?");
    expect(board).not.toContain("Ремонт · 1\n• Позвонить мастеру\nСкажи");
  });

  it("separates a family project from a personal one of the same name", () => {
    const board = formatTaskBoard({
      now: NOW, style: "plain", timezone: "UTC",
      tasks: [task("Своё", { listName: "Дом", source: "Личное" }), task("Общее", { listName: "Дом", source: "Семья" })],
    })!;

    expect(board).toContain("Дом · 1\n• Своё");
    expect(board).toContain("Дом (Семья) · 1\n• Общее");
  });

  it("folds a long list into its first items and a count, never into a hidden block", () => {
    const tasks = Array.from({ length: 8 }, (_, index) => task(`Дело ${index + 1}`, { listName: "Работа" }));
    const board = formatTaskBoard({ now: NOW, perGroup: 3, style: "plain", tasks, timezone: "UTC" })!;

    expect(board).toContain("Работа · 8\n• Дело 1\n• Дело 2\n• Дело 3\n…и ещё 5");
  });

  it("marks headings bold for a model answer and keeps a title from breaking them", () => {
    const board = formatTaskBoard({ now: NOW, style: "rich", timezone: "UTC", tasks: [task("Купить **всё**", { listName: "Дом" })] })!;

    expect(board).toContain("**Дом · 1**\n\n- Купить \\*\\*всё\\*\\*");
  });

  it("gives a model answer real Markdown blocks, because a lone newline is only a space there", () => {
    // Прод 23 сентября 2026: доска ушла моделью дословно, но Telegram отрисовал её как Rich
    // Markdown, склеил строки секции в абзац, и человек получил стену текста.
    const tasks = [task("Отвезти матрас", { listName: "Дом" }), task("Зарядить аккумулятор", { listName: "Дом" })];
    const rich = formatTaskBoard({ now: NOW, style: "rich", tasks, timezone: "UTC" })!;

    expect(rich).toContain("**Дом · 2**\n\n- Отвезти матрас\n- Зарядить аккумулятор");
    expect(rich).not.toContain("•");
    // Простое сообщение служб уходит без разметки, там перевод строки работает сам по себе.
    const plain = formatTaskBoard({ now: NOW, style: "plain", tasks, timezone: "UTC" })!;

    expect(plain).toContain("Дом · 2\n• Отвезти матрас\n• Зарядить аккумулятор");
  });

  it("keeps an overflow tail out of the last list item", () => {
    const tasks = Array.from({ length: 7 }, (_, index) => task(`Дело ${index + 1}`, { listName: "Дом" }));
    const rich = formatTaskBoard({ now: NOW, perGroup: 2, style: "rich", tasks, timezone: "UTC" })!;

    expect(rich).toContain("- Дело 2\n\n…и ещё 5");
  });

  it("never lets a task title become markup in someone else's board", () => {
    const board = formatTaskBoard({
      now: NOW, style: "rich", timezone: "UTC",
      tasks: [task("[Смотри](https://evil.example) `код` **жирный** | конец", { listName: "Дом" })],
    })!;

    expect(board).toContain("\\[Смотри\\]\\(https://evil.example\\)");
    expect(board).toContain("\\`код\\`");
    expect(board).not.toMatch(/(^|[^\\])\*\*жирный/u);
  });

  it("keeps the board inside one Telegram message and says what it dropped", () => {
    const tasks = Array.from({ length: 60 }, (_, index) =>
      task(`Дело ${index + 1} ${"я".repeat(150)}`, { listName: `Список ${index}` }));

    const board = formatTaskBoard({ now: NOW, style: "plain", tasks, timezone: "UTC" })!;

    expect(board.length).toBeLessThanOrEqual(TASK_BOARD_MAX_CHARACTERS);
    expect(board).toMatch(/…и ещё \d+ раздела, спроси о них отдельно/u);
    expect(board).toContain("Открытых дел: 60");
    // Длинное название обрезается, а не переносит доску за предел.
    expect(board).toContain("…");
  });

  it("stays silent when nothing is open", () => {
    expect(formatTaskBoard({ now: NOW, style: "plain", timezone: "UTC", tasks: [task("Готово", { status: "completed" })] })).toBeNull();
  });

  it("gives the model a board that reaches the chat whole and bold", () => {
    const tasks = Array.from({ length: 30 }, (_, index) => task(`Дело с довольно длинным названием ${index + 1}`, { listName: index % 2 ? "Работа" : "Дом" }));
    const reply = taskBoardReply(tasks, NOW, "UTC")!;
    const delivered = formatTelegramFinalPresentation(reply).map((chunk) => chunk.text).join("\n");

    expect(delivered).not.toContain("Полный ответ");
    expect(delivered).not.toContain("telegram-keep-open");
    expect(delivered).toContain("Дело с довольно длинным названием 2");
    expect(taskBoardReply([], NOW, "UTC")).toBeNull();
  });

  it("keeps the list name in the heading and puts the life area next to it", () => {
    // До 1 октября 2026 сфера вытесняла имя списка из заголовка, и проект «Переезд» на доске не было видно.
    const board = formatTaskBoard({
      now: NOW, style: "plain", timezone: "UTC",
      tasks: [
        task("Записаться на йогу", { lifeArea: "self", listName: "Здоровье" }),
        task("Купить фильтры", { lifeArea: "home", listName: "Дом" }),
        task("Отвезти машину", { listName: "Дом" }),
        task("Позвонить маме", { lifeArea: "couple" }),
      ],
    })!;

    expect(board).toContain("Здоровье (Для себя) · 1\n• Записаться на йогу");
    expect(board).toContain("Дом (Дом и забота) · 1\n• Купить фильтры");
    // Дело без метки остаётся в своём списке: сферу проставляет только человек.
    expect(board).toContain("Дом · 1\n• Отвезти машину");
    // Без списка заголовком остаётся сама сфера.
    expect(board).toContain("Мы вдвоём · 1\n• Позвонить маме");
  });
  it("puts what nobody sorted yet into its own section, with the way out", () => {
    // 29 сентября 2026 на проде 21 из 56 открытых дел лежали «Без списка» последним разделом, и никто
    // не просил их разобрать. Теперь они видны отдельно и с подсказкой, что сказать.
    const board = formatTaskBoard({
      now: NOW, style: "plain", timezone: "UTC",
      tasks: [
        task("Разобраться с кружком"), task("Решить про отпуск"),
        task("Отвезти машину", { listName: "Дом" }),
        task("Оплатить штраф", { dueOn: "2026-10-05" }),
        task("Керамика", { kind: "idea" }),
      ],
    })!;

    expect(board).toContain("Разобрать · 2\n• Разобраться с кружком\n• Решить про отпуск\nСкажи, куда положить или какой первый шаг.");
    // Без списка, но со сроком: дело уже распланировано, разбирать его не нужно.
    expect(board).toContain("Без списка · 1\n• Оплатить штраф — до 05.10");
    expect(board).not.toContain("Разобрать · 3");
    // Идея ничего не обещает и разбора не требует.
    expect(board).toContain("Когда-нибудь · 1\n• Керамика");
  });

  it("keeps the hint as its own paragraph in a model answer, where a lone newline is a space", () => {
    const rich = formatTaskBoard({ now: NOW, style: "rich", timezone: "UTC", tasks: [task("Разобраться с кружком")] })!;

    expect(rich).toContain("**Разобрать · 1**\n\n- Разобраться с кружком\n\nСкажи, куда положить или какой первый шаг.");
  });

  it("does not ask to sort a task that has a life area or a plan", () => {
    const board = formatTaskBoard({
      now: NOW, style: "plain", timezone: "UTC",
      tasks: [task("Записаться на йогу", { lifeArea: "self" }), task("Собрать документы", { plannedFrom: "2026-09-25", plannedUntil: "2026-09-26" })],
    })!;

    expect(board).not.toContain("Разобрать");
  });
});
