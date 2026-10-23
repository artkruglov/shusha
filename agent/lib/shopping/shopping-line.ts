/**
 * Одна строка покупок, написанная человеком: сколько в ней пунктов.
 *
 * Экспорт:
 * - `splitShoppingLine`: пункты строки «молоко, хлеб, яйца».
 *
 * Запятая делит список, как люди его пишут, но та же запятая стоит внутри числа («молоко 3,2 %») и перед
 * количеством («сметана, 2 банки»): прежний разрез по любой запятой давал пункты «Молоко 3» и «2 %».
 * Здесь запятая между цифрами и запятая перед числом с единицей остаются в пункте; точка с запятой и
 * перевод строки делят всегда.
 */

/**
 * A quantity after a comma: a number, maybe decimal, and a unit. Single-letter and abbreviated units (г, л, м,
 * шт, кг, мл, гр) must end the word, otherwise «, 2 гвоздики» would read as two grams; word units may carry any
 * ending («банки», «банок»). `\b` knows only Latin letters, so the boundary is a lookahead.
 */
const QUANTITY_AFTER_COMMA = new RegExp(
  "^\\s*\\d+(?:[.,]\\d+)?\\s*(?:(?:кг|мл|гр|шт|г|л|м)(?!\\p{L})"
  + "|(?:штук|грамм|литр|банк|пач|упак|бутыл|короб|пакет|десят|кус|рулон|ящик|мешк|мешок|пар|порци|доль|дольк|зубчик|пучк|пучок|буханк|батон)\\p{L}*)",
  "iu",
);

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

/** Items of one line: trimmed, without empties; the line itself when nothing divides it. */
export function splitShoppingLine(line: string): string[] {
  const items: string[] = [];
  let current = "";
  const characters = Array.from(line);
  for (const [index, character] of characters.entries()) {
    const divides = character === ";" || character === "\n"
      || (character === "," && !(isDigit(characters[index - 1]) && isDigit(characters[index + 1]))
        && !QUANTITY_AFTER_COMMA.test(characters.slice(index + 1).join("")));
    if (divides) {
      items.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}
