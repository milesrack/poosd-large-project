import type { Settings } from "../shared/contracts.ts";
import { DEFAULT_SETTINGS as DEFAULTS } from "../shared/settings.ts";

const invalid = (message: string) =>
  Object.assign(new Error(message), { status: 400 });

export { DEFAULTS };

export function parseSettings(value: unknown = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("Invalid settings");
  }

  if (Object.keys(value).some((key) => !Object.hasOwn(DEFAULTS, key))) {
    throw invalid("Unsupported setting");
  }

  const settings = { ...DEFAULTS, ...value } as Settings;

  if (
    typeof settings.profileId !== "string" ||
    !/^(published|[a-f0-9-]{36})$/.test(settings.profileId)
  ) {
    throw invalid("Invalid weight profile");
  }

  for (const key of ["add", "sub", "mul", "div"] as const) {
    if (typeof settings[key] !== "boolean") {
      throw invalid("Invalid operation setting");
    }
  }

  if (!(["add", "sub", "mul", "div"] as const).some((key) => settings[key])) {
    throw invalid("Select at least one operation");
  }

  for (const bank of ["add", "mul"] as const) {
    for (const side of ["left", "right"] as const) {
      const min = settings[`${bank}_${side}_min`];
      const max = settings[`${bank}_${side}_max`];

      if (
        !Number.isSafeInteger(min) ||
        !Number.isSafeInteger(max) ||
        min > max
      ) {
        throw invalid("Ranges must contain ordered safe integers");
      }
    }
  }

  if (
    settings.div &&
    settings.mul_left_min === 0 &&
    settings.mul_left_max === 0
  ) {
    throw invalid("Division requires a non-zero factor range");
  }

  if (![30, 60, 120, 300, 600].includes(settings.duration)) {
    throw invalid("Invalid session duration");
  }

  const bound = (bank: "add" | "mul", side: "left" | "right") =>
    Math.max(
      Math.abs(settings[`${bank}_${side}_min`]),
      Math.abs(settings[`${bank}_${side}_max`]),
    );

  if (
    ((settings.add || settings.sub) &&
      !Number.isSafeInteger(bound("add", "left") + bound("add", "right"))) ||
    ((settings.mul || settings.div) &&
      !Number.isSafeInteger(bound("mul", "left") * bound("mul", "right")))
  ) {
    throw invalid("Ranges exceed Zetamac's integer precision");
  }

  return settings;
}
