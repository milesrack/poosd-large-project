import { randomSource } from "../server/brain/random.ts";
import { ZETAMAC_SETTINGS } from "../shared/settings.ts";
import {
  arithmeticQuestions,
  arithmeticSplit,
  groupKey,
} from "./arithmetic-data.ts";

export const SEQUENCE_PROTOCOL = {
  version: 1,
  seeds: [42, 43, 44],
  brain: { steps: 2, settle: 6, maxKeys: 8 },
  warmup: { updates: 1000, batch: 32, rate: 0.003, validateEvery: 100 },
  refinement: { updates: 128, batch: 1, rate: 0.003, validateEvery: 32 },
  selection: { metric: "validation_cross_entropy", includeInitial: true },
  curriculum: "grouped_digit_factor_families",
  encoding: "decimal_autoregressive",
  dynamics: {
    normalisation: "incoming_l2",
    activation: "tanh",
    gains: "positive",
    retention: "sigmoid",
    stateReset: "question",
  },
  controls: ["frozen", "reset_internal", "training_majority"],
  targets: "non_negative_integers",
  teacherForcing: ["training", "validation_loss"],
} as const;

function encode(rows: ReturnType<typeof arithmeticQuestions>) {
  return rows.map((row) => ({
    expression: `${row.a}${row.operation}${row.b}`,
    answer: String(row.answer),
    operation: row.operation,
    family: groupKey(row),
  }));
}

function zetamacSplit(full: boolean) {
  const settings = ZETAMAC_SETTINGS;
  const minimum = Math.min(
    settings.add_left_min,
    settings.add_right_min,
    settings.mul_left_min,
    settings.mul_right_min,
  );
  const maximum = Math.max(
    settings.add_left_max,
    settings.add_right_max,
    settings.mul_left_max,
    settings.mul_right_max,
  );
  const groups: [number, number][] = [];

  for (let a = minimum; a <= maximum; a++) {
    for (let b = a; b <= maximum; b++) {
      groups.push([a, b]);
    }
  }

  const random = randomSource(20261023);

  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [groups[i], groups[j]] = [groups[j], groups[i]];
  }

  const banks: Record<
    "training" | "validation" | "test",
    ReturnType<typeof arithmeticQuestions>
  > = {
    training: [],
    validation: [],
    test: [],
  };

  for (const [a, b] of groups) {
    let hash = 2166136261;

    for (const char of `${a}:${b}`) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    }

    const bucket = (hash >>> 0) % 10;
    const bank =
      banks[bucket < 8 ? "training" : bucket === 8 ? "validation" : "test"];

    for (const [x, y] of a === b
      ? [[a, b]]
      : [
          [a, b],
          [b, a],
        ]) {
      bank.push(
        ...arithmeticQuestions(x, y, "left").filter((row) => {
          const name =
            row.operation === "+" || row.operation === "-" ? "add" : "mul";

          return (
            x >= settings[`${name}_left_min`] &&
            x <= settings[`${name}_left_max`] &&
            y >= settings[`${name}_right_min`] &&
            y <= settings[`${name}_right_max`]
          );
        }),
      );
    }
  }

  const select = (
    rows: ReturnType<typeof arithmeticQuestions>,
    count: number,
  ) =>
    encode(
      (["+", "-", "*", "/"] as const).flatMap((operation) =>
        rows
          .filter((row) => row.operation === operation)
          .slice(0, full ? undefined : count),
      ),
    );
  const longer: ReturnType<typeof arithmeticQuestions> = [];

  for (let a = maximum + 1; a <= maximum + 9; a++) {
    for (let b = maximum + 1; b <= maximum + 9; b++) {
      longer.push(...arithmeticQuestions(a, b, "left"));
    }
  }

  return {
    training: select(banks.training, 512),
    validation: select(banks.validation, 48),
    test: select(banks.test, 64),
    extrapolation: encode(longer),
  };
}

export function sequenceSplit(curriculum = "digits", full = false) {
  if (curriculum === "zetamac") {
    return zetamacSplit(full);
  }

  if (curriculum !== "digits") {
    throw Error("Use digits or zetamac curriculum");
  }

  const numeric = arithmeticSplit();

  return {
    training: encode(numeric.training),
    validation: encode(numeric.validation),
    test: encode(numeric.test),
    extrapolation: encode(numeric.extrapolation),
  };
}

export function sequenceProtocol(schedule: string) {
  if (!["baseline", "gentle", "signal"].includes(schedule)) {
    throw Error("Use baseline, gentle, or signal schedule");
  }

  return {
    ...SEQUENCE_PROTOCOL,
    version: schedule === "signal" ? 3 : schedule === "gentle" ? 2 : 1,
    schedule,
    brain: {
      ...SEQUENCE_PROTOCOL.brain,
      coupling: schedule === "signal" ? 3 : 0.25,
    },
    refinement:
      schedule !== "baseline"
        ? { updates: 256, batch: 1, rate: 0.0001, validateEvery: 64 }
        : SEQUENCE_PROTOCOL.refinement,
  };
}

export function balancedSequenceSampler<T extends { operation: string }>(
  rows: T[],
  seed: number,
) {
  const random = randomSource(seed);
  const groups = ["+", "-", "*", "/"].map((operation) =>
    rows.filter((row) => row.operation === operation),
  );
  if (groups.some((group) => group.length === 0)) {
    throw Error("Training requires all four operations");
  }
  const positions = groups.map((group) => group.length);
  let operation = 0;
  return (count: number): T[] => {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw Error("Invalid training batch size");
    }
    return Array.from({ length: count }, () => {
      const index = operation++ % groups.length;
      const group = groups[index];
      if (positions[index] === group.length) {
        for (let i = group.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [group[i], group[j]] = [group[j], group[i]];
        }
        positions[index] = 0;
      }
      return group[positions[index]++];
    });
  };
}

export function memorizationSplit(limit?: number) {
  const full = sequenceSplit("zetamac", true);
  const pool = [
    ...new Map(
      [...full.training, ...full.validation, ...full.test].map((row) => [
        row.expression,
        row,
      ]),
    ).values(),
  ];
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) ||
      limit < 4 ||
      limit > pool.length ||
      limit % 4)
  ) {
    throw Error(
      "Memorisation sample size must be a multiple of four within the default pool",
    );
  }
  let training = pool;
  if (limit !== undefined && limit < pool.length) {
    const sample = balancedSequenceSampler(pool, 20261025);
    const selected = new Map<string, (typeof pool)[number]>();
    while (selected.size < limit) {
      for (const row of sample(4)) {
        selected.set(row.expression, row);
        if (selected.size === limit) {
          break;
        }
      }
    }
    training = [...selected.values()];
  }
  const validation = balancedSequenceSampler(
    training,
    20261026,
  )(Math.min(64, training.length));
  return {
    training,
    validation,
    test: validation,
    extrapolation: [] as typeof training,
  };
}
