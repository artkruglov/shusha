/** Installation-owned name shared by inbound routing and model context. */
import { z } from "zod";

const DEFAULT_NAME = "Шуша";
// Case forms the bot answers to when TELEGRAM_AGENT_ALIASES is empty.
const KNOWN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "шуша": ["Шуши", "Шуше", "Шушу", "Шушей", "Шушею", "Shusha"],
  // The bot moves to Юна (@yuna_agent): «Шуша» is someone else's trademark (21 October 2026).
  "юна": ["Юны", "Юне", "Юну", "Юной", "Юною", "Yuna"],
  // The project was called Хомка until 1 October 2026: an installation that still names itself so
  // keeps the name set it had.
  "хомка": ["Хомки", "Хомке", "Хомку", "Хомкой", "Хомкою", "Homka", "Khomka"],
  // An installation that still names itself Osinara keeps the name set it had before Хомка.
  "осинара": [
    "Осинар", "Осинары", "Осинаре", "Осинару", "Осинарой", "Осинарою",
    "Асинара", "Асинары", "Асинаре", "Асинару", "Асинарой", "Сена", "Osinara", "Asinara",
  ],
};
/** The name in each Russian case, for text the code writes («спросить Юну», «с Юной»). */
export interface TelegramAgentNameCases {
  readonly nominative: string;
  readonly genitive: string;
  readonly dative: string;
  readonly accusative: string;
  readonly instrumental: string;
  readonly prepositional: string;
}
// [genitive, dative, accusative, instrumental, prepositional]; a name not listed keeps its nominative in every case.
const KNOWN_CASES: Readonly<Record<string, readonly [string, string, string, string, string]>> = {
  "шуша": ["Шуши", "Шуше", "Шушу", "Шушей", "Шуше"],
  "юна": ["Юны", "Юне", "Юну", "Юной", "Юне"],
};
const nameSchema = z.string().trim().min(1).max(40)
  .regex(/^[\p{L}][\p{L}\p{M}\p{N} -]*$/u);
const aliasesSchema = z.array(nameSchema).max(32);

export interface TelegramAgentIdentity {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly cases: TelegramAgentNameCases;
}

/** Empty environment values use defaults; an explicit [] disables additional names. */
export function readTelegramAgentIdentity(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TelegramAgentIdentity {
  const name = nameSchema.safeParse(environment.TELEGRAM_AGENT_NAME?.trim() || DEFAULT_NAME);
  let aliasesInput: unknown;
  try {
    aliasesInput = environment.TELEGRAM_AGENT_ALIASES?.trim()
      ? JSON.parse(environment.TELEGRAM_AGENT_ALIASES)
      : name.success ? KNOWN_ALIASES[name.data.toLowerCase()] ?? [] : [];
  } catch {
    throw invalidIdentity();
  }
  const aliases = aliasesSchema.safeParse(aliasesInput);
  if (!name.success || !aliases.success) throw invalidIdentity();
  const nominative = name.data.normalize("NFC");
  const [genitive, dative, accusative, instrumental, prepositional] =
    KNOWN_CASES[nominative.toLowerCase()] ?? Array<string>(5).fill(nominative);
  return {
    name: nominative,
    aliases: [...new Set(aliases.data.map((alias) => alias.normalize("NFC")))],
    cases: { nominative, genitive: genitive!, dative: dative!, accusative: accusative!, instrumental: instrumental!,
      prepositional: prepositional! },
  };
}

function invalidIdentity(): Error {
  // Never echo configuration contents into logs or a user-facing error.
  return new Error("AGENT_TELEGRAM_IDENTITY_INVALID: Проверьте TELEGRAM_AGENT_NAME и TELEGRAM_AGENT_ALIASES");
}

let cachedPattern: { readonly key: string; readonly value: RegExp } | undefined;

export function matchesTelegramAgentName(text: string): boolean {
  const identity = readTelegramAgentIdentity();
  const names = [identity.name, ...identity.aliases];
  const key = JSON.stringify(names);
  if (cachedPattern?.key !== key) {
    const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
    const word = "\\p{L}\\p{M}\\p{N}\\p{Pc}\\u200C\\u200D";
    cachedPattern = { key, value: new RegExp(`(?:^|[^${word}])(?:${alternatives})(?=$|[^${word}])`, "iu") };
  }
  // Normalize only the comparison copy; preserve the original message in storage and delivery.
  return cachedPattern.value.test(text.normalize("NFC"));
}
