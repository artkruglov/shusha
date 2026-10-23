/**
 * Integer tuning settings read from the environment.
 *
 * Export:
 * - `integerSetting`: the named variable as an integer within bounds, or its default when absent.
 *
 * Key construct:
 * - One installation serves one family on one core, another serves many on a bigger machine;
 *   what differs between them is a handful of numbers, so each is an environment variable with
 *   the single-family value as the default (port of ilkruglov 5e7604c2). Compose passes an unset
 *   variable through as an empty string, so blank counts as absent, as `SANDBOX_MAX_RUNNING`
 *   reads it; a value outside its bounds or not an integer fails at start instead of running
 *   with a guess.
 */
import { AppError } from "./app-error.js";

export interface IntegerSettingBounds {
  /** Value used when the variable is not set or blank. */
  readonly absent: number;
  readonly min: number;
  readonly max: number;
}

export function integerSetting(
  name: string,
  bounds: IntegerSettingBounds,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return bounds.absent;
  const value = Number(raw);
  if (!/^-?\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new AppError(
      "AGENT_RUNTIME_TUNING_INVALID",
      `${name} должно быть целым от ${bounds.min} до ${bounds.max}`,
    );
  }
  return value;
}
