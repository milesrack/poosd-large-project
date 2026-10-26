import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  expressionColumns,
  plasticConnections,
  RewardPlasticity,
  selectAction,
} from "../research/plasticity.ts";
import { Brain } from "../research/simulator.ts";
import { loadAnatomy } from "../server/brain/anatomy.ts";
import { loadGraph, sha256 } from "../server/brain/graph.ts";
import { randomSource } from "../server/brain/random.ts";
import { DEFAULT_SETTINGS } from "../shared/settings.ts";
import { balancedSequenceSampler, sequenceSplit } from "./sequence-data.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    task: { type: "string", default: "arithmetic" },
    episodes: { type: "string", default: "64" },
    seed: { type: "string", default: "44" },
    rate: { type: "string", default: "0.1" },
  },
});
const output = values.output;
const episodes = Number(values.episodes);
const seed = Number(values.seed);
const rate = Number(values.rate);
const task = values.task;
if (
  !output ||
  !["conditioning", "arithmetic"].includes(task!) ||
  !Number.isSafeInteger(episodes) ||
  episodes < 1 ||
  episodes > 100000 ||
  !Number.isSafeInteger(seed) ||
  seed < 0 ||
  !Number.isFinite(rate) ||
  rate < 0 ||
  rate > 0.5
) {
  throw Error(
    "Use --output with a new directory, --task conditioning or arithmetic, and valid training options",
  );
}
await mkdir(output, { recursive: false });
const sources = [
  "scripts/train-plasticity.ts",
  "research/plasticity.ts",
  "research/simulator.ts",
  "server/brain/anatomy.ts",
  "server/brain/graph.ts",
  "server/brain/random.ts",
  "server/brain/arrays.ts",
  "scripts/sequence-data.ts",
  "scripts/arithmetic-data.ts",
  "shared/settings.ts",
  "package-lock.json",
];
const hashes: Record<string, string> = {};
for (const path of sources) {
  const bytes = await readFile(path);
  await mkdir(join(output, "source", path, ".."), { recursive: true });
  await writeFile(join(output, "source", path), bytes);
  hashes[path] = sha256(bytes);
}
const started = performance.now();
const log = (row: object) =>
  console.log(
    JSON.stringify({ ...row, seconds: (performance.now() - started) / 1000 }),
  );
const base = await loadGraph();
const anatomy = await loadAnatomy();
const circuit = anatomy.learning;
const eligible = plasticConnections(base, circuit);
const shuffle = <T>(items: T[], random: () => number) => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};
const projection = shuffle(
  circuit.projection.filter(
    (neuron) =>
      base.offsets[neuron + 1] > base.offsets[neuron] &&
      base.weights[base.edges[base.offsets[neuron]]] > 0,
  ),
  randomSource(seed),
);
const copies = 4;
const operations = "+-*/";
const symbols = task === "conditioning" ? "01" : "0123456789-\n";
const channelCount = task === "conditioning" ? 21 : 36;
if (projection.length < channelCount * copies) {
  throw Error("Insufficient identified projection neurons");
}
const channels = Array.from({ length: channelCount }, (_, index) =>
  projection.slice(index * copies, (index + 1) * copies),
);
const targets = shuffle(
  [...new Set(Array.from(eligible, (edge) => base.post[edge]))],
  randomSource(seed),
);
const actions = symbols.length;
const groups = Array.from({ length: actions }, (_, action) =>
  targets.filter((_, i) => i % actions === action),
);
const stimulus = (
  column: readonly [number, number] | null,
  operation?: string,
  previous?: string,
) => {
  const neurons = column
    ? [...channels[column[0]], ...channels[10 + column[1]]]
    : [...channels[20]];
  if (operation) {
    neurons.push(...channels[21 + operations.indexOf(operation)]);
    if (previous !== undefined) {
      neurons.push(...channels[25 + symbols.indexOf(previous)]);
    }
  }
  const rate = operation ? 1200 / neurons.length : 150;
  return neurons.map((neuron) => ({ neuron, rate }));
};
const calibrationCues =
  task === "conditioning"
    ? [
        [2, 7],
        [0, 0],
        [1, 1],
        [9, 1],
      ].map((column) => stimulus(column as [number, number]))
    : Array.from(operations).flatMap((operation) => [
        stimulus([2, 7], operation),
        stimulus(null, operation, "0"),
      ]);
const thresholds = new Float64Array(base.offsets.length - 1).fill(-0.045);
const calibration: object[] = [];
let selectedThreshold: number | null = null;
let readoutScale: number[] = [];
for (const threshold of [-0.045, -0.04, -0.035, -0.03, -0.025]) {
  for (const neuron of circuit.kenyon) {
    thresholds[neuron] = threshold;
  }
  const probe = new Brain({ ...base, inputs: [] }, thresholds);
  const rows = calibrationCues.map((cue, i) => {
    const observation = probe.stimulate(cue, {
      durationMs: 100,
      random: randomSource(seed + i),
    });
    return {
      activeFraction:
        circuit.kenyon.filter((neuron) => observation.counts[neuron] > 0)
          .length / circuit.kenyon.length,
      rates: groups.map(
        (group) =>
          group.reduce((sum, neuron) => sum + observation.counts[neuron], 0) /
          group.length,
      ),
      outputSpikes: targets.reduce(
        (sum, neuron) => sum + observation.counts[neuron],
        0,
      ),
    };
  });
  const fraction =
    rows.reduce((sum, row) => sum + row.activeFraction, 0) / rows.length;
  calibration.push({ threshold, fraction, rows });
  log({
    phase: "calibration",
    threshold,
    fraction,
    outputSpikes: rows.map((row) => row.outputSpikes),
  });
  if (
    fraction >= 0.005 &&
    fraction <= 0.1 &&
    rows.every((row) => row.outputSpikes > 0)
  ) {
    selectedThreshold = threshold;
    readoutScale = groups.map((group, action) =>
      Math.max(
        1 / group.length,
        rows.reduce((sum, row) => sum + row.rates[action], 0) / rows.length,
      ),
    );
    break;
  }
}
const conditions =
  task === "conditioning"
    ? (["plastic", "frozen", "shuffled"] as const)
    : (["plastic", "frozen"] as const);
const protocol = {
  conditions,
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  sources: hashes,
  task,
  encoding:
    task === "arithmetic"
      ? "aligned_decimal_columns_then_autoregressive_digits"
      : "paired_cues",
  outputSymbols: symbols,
  actionSelection: "sampled_softmax_of_normalised_MBON_cost",
  outputOrder: "least_significant_digit_first",
  settings: task === "arithmetic" ? DEFAULT_SETTINGS : undefined,
  frozenControl: "no_training_initial_predictions_reused",
  seed,
  episodes,
  rate,
  population: base.offsets.length - 1,
  connections: base.edges.length,
  annotations: anatomy.annotationSha256,
  neuronOrder: anatomy.neuronOrderSha256,
  plasticEdges: eligible.length,
  channels,
  groups,
  calibration,
  selectedThreshold,
  readoutScale,
  dynamics: {
    dtMs: 0.1,
    membraneMs: 20,
    synapseMs: 5,
    delayMs: 1.8,
    refractoryMs: 2.2,
  },
  plasticity: {
    rule: "dopamine_gated_presynaptic_eligibility",
    eligibilityMs: 500,
    expectation: "normalised_MBON_softmax_confidence",
    bounds: [0.05, 3],
    anatomicalGate: "positive_KC_to_direct_DAN_targeted_MBON",
  },
  assumptions: [
    "scalar_reward_modulator",
    "direct_DAN_adjacency_as_compartment_proxy",
    "activity_calibrated_KC_threshold",
    "abstract_projection_neuron_cues",
    "label_free_rate_normalised_action_cost_decoder",
    "selected_action_feedback_gates_modulation",
  ],
  feedback: "per_output_correctness_only",
  inputCarry: false,
  outputCarry: false,
  references: [
    "https://doi.org/10.1038/s41586-024-07763-9",
    "https://doi.org/10.1038/s41467-021-22592-4",
    "https://doi.org/10.1016/j.neuron.2015.11.003",
  ],
};
await writeFile(
  join(output, "protocol.json"),
  `${JSON.stringify(protocol, null, 2)}\n`,
);
if (selectedThreshold === null) {
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ status: "activity_gate_failed", calibration }, null, 2),
  );
  log({
    phase: "stopped",
    reason: "No calibrated sparse and responsive regime",
  });
} else {
  interface Trial {
    columns: readonly (readonly [number, number])[];
    target: string;
    operation?: string;
    expression?: string;
    family?: string;
  }
  const training: Trial[] = [];
  const validation: Trial[] = [];
  const transfer: Trial[] = [];
  if (task === "conditioning") {
    for (let i = 0; i < episodes; i++) {
      training.push({ columns: [[i % 2, i % 2]], target: String(i % 2) });
    }
    shuffle(training, randomSource(seed + 1));
    for (let i = 0; i < 32; i++) {
      validation.push({ columns: [[i % 2, i % 2]], target: String(i % 2) });
    }
  } else {
    const split = sequenceSplit("zetamac", true);
    const encode = (row: {
      expression: string;
      answer: string;
      family: string;
    }): Trial => ({
      family: row.family,
      ...expressionColumns(row.expression),
      expression: row.expression,
      target: `${Array.from(row.answer).reverse().join("")}\n`,
    });
    training.push(
      ...balancedSequenceSampler(
        split.training,
        seed + 1,
      )(episodes).map(encode),
    );
    validation.push(
      ...balancedSequenceSampler(split.validation, seed + 2)(16).map(encode),
    );
    transfer.push(
      ...balancedSequenceSampler(split.extrapolation, seed + 3)(8).map(encode),
    );
  }
  shuffle(validation, randomSource(seed + 3));
  await writeFile(
    join(output, "data.json"),
    `${JSON.stringify({ training, validation, transfer }, null, 2)}\n`,
  );
  const rewarded: number[] = [];
  const results: object[] = [];
  let shuffledRewards: number[] = [];
  for (const condition of conditions) {
    const graph = { ...base, inputs: [], weights: base.weights.slice() };
    const brain = new Brain(graph, thresholds);
    const plasticity = new RewardPlasticity(graph, eligible, {
      rate: condition === "frozen" ? 0 : rate,
    });
    const feedback: number[] = [];
    const delivered: number[] = [];
    let changed = 0;
    const reinforce = (
      reward: number,
      targets: readonly number[],
      expectation: number,
    ) => {
      const signal =
        condition === "shuffled"
          ? shuffledRewards[feedback.length % shuffledRewards.length]
          : reward;
      changed += plasticity.reward(signal, targets, expectation).changed;
      feedback.push(reward);
      delivered.push(signal);
    };
    const episode = (trial: Trial, trialSeed: number, learning: boolean) => {
      brain.reset();
      plasticity.reset();
      const random = randomSource(trialSeed);
      const activeFractions: number[] = [];
      let emitted = "";
      let silent = false;
      if (task === "arithmetic") {
        for (const column of trial.columns) {
          brain.stimulate(stimulus(column, trial.operation), {
            durationMs: 100,
            reset: false,
            random,
            onStep: learning ? plasticity.step : undefined,
          });
        }
      }
      for (
        let step = 0;
        step < (task === "conditioning" ? 1 : trial.columns.length * 2 + 2);
        step++
      ) {
        const observation = brain.stimulate(
          task === "conditioning"
            ? stimulus(trial.columns[step] ?? null)
            : stimulus(null, trial.operation, emitted.at(-1)),
          {
            durationMs: 100,
            reset: false,
            random,
            onStep: learning ? plasticity.step : undefined,
          },
        );
        activeFractions.push(
          circuit.kenyon.filter((neuron) => observation.counts[neuron] > 0)
            .length / circuit.kenyon.length,
        );
        const activity = groups.map(
          (group, action) =>
            group.reduce((sum, neuron) => sum + observation.counts[neuron], 0) /
            group.length /
            readoutScale[action],
        );
        const maximum = Math.max(...activity);
        if (maximum === 0) {
          silent = true;
          if (learning) {
            reinforce(0, [], 0);
          }
          break;
        }
        const { action, confidence } = selectAction(activity, random);
        const token = symbols[action];
        emitted += token;
        if (learning) {
          reinforce(
            Number(token === trial.target[step]),
            groups[action],
            confidence,
          );
        }
        if (token === "\n") {
          break;
        }
      }
      return {
        emitted,
        answer: Array.from(emitted.replace("\n", "")).reverse().join(""),
        correct: !silent && emitted === trial.target,
        silent,
        activeKenyonFraction:
          activeFractions.reduce((sum, value) => sum + value, 0) /
          activeFractions.length,
      };
    };
    const evaluate = (trials = validation, offset = 100000) => {
      const predictions = trials.map((trial, i) => ({
        expression: trial.expression,
        expected: Array.from(trial.target.replace("\n", "")).reverse().join(""),
        ...episode(trial, seed + offset + i, false),
      }));
      return {
        byOperation:
          task === "arithmetic"
            ? Object.fromEntries(
                Array.from(operations, (operation) => {
                  const selected = predictions.filter(
                    (_, i) => trials[i].operation === operation,
                  );
                  return [
                    operation,
                    {
                      correct: selected.filter((row) => row.correct).length,
                      total: selected.length,
                    },
                  ];
                }),
              )
            : undefined,
        correct: predictions.filter((row) => row.correct).length,
        total: predictions.length,
        silent: predictions.filter((row) => row.silent).length,
        predictions,
      };
    };
    const initial = evaluate();
    await writeFile(
      join(output, "results.json"),
      `${JSON.stringify({ status: condition === "frozen" ? "evaluating_control" : "training", task, results, current: { condition, initial } }, null, 2)}\n`,
    );
    log({
      phase: "initial",
      condition,
      correct: initial.correct,
      total: initial.total,
    });
    for (let i = 0; condition !== "frozen" && i < training.length; i++) {
      episode(training[i], seed + 1000 + i, true);
      if ((i + 1) % (task === "arithmetic" ? 4 : 16) === 0) {
        log({
          phase: "training",
          condition,
          episode: i + 1,
          rewards: feedback.reduce((sum, value) => sum + value, 0),
          changed,
        });
      }
    }
    await writeFile(join(output, `${condition}.npz`), plasticity.checkpoint());
    if (
      condition === "shuffled" &&
      (delivered.length !== rewarded.length ||
        delivered.reduce((sum, value) => sum + value, 0) !==
          rewarded.reduce((sum, value) => sum + value, 0))
    ) {
      throw Error(
        "Shuffled feedback must preserve reward count and distribution",
      );
    }
    const final = condition === "frozen" ? initial : evaluate();
    const row = {
      condition,
      initial,
      final,
      transfer: transfer.length ? evaluate(transfer, 300000) : undefined,
      synapticUpdates: changed,
      changedSynapses: Array.from(eligible).filter(
        (edge) => graph.weights[edge] !== base.weights[edge],
      ).length,
      rewards: feedback,
      deliveredRewards: delivered,
    };
    results.push(row);
    if (condition === "plastic") {
      rewarded.push(...feedback);
      shuffledRewards = shuffle(rewarded.slice(), randomSource(seed + 200000));
    }
    await writeFile(
      join(output, "results.json"),
      `${JSON.stringify({ status: results.length === conditions.length ? "finished_controls" : "running_controls", task, results }, null, 2)}\n`,
    );
    log({
      phase: "evaluation",
      condition,
      correct: final.correct,
      total: final.total,
      byOperation: final.byOperation,
      changed,
    });
  }
  log({ phase: "finished", task });
}
