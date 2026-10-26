import { createHash } from "node:crypto";
import { decodeArchive, encodeArchive } from "../server/brain/arrays.ts";
import type { BrainGraph } from "../server/brain/graph.ts";

interface Circuit {
  kenyon: number[];
  output: number[];
  dopamine: number[];
}

export function plasticConnections(graph: BrainGraph, circuit: Circuit) {
  const output = new Set(circuit.output);
  const modulated = new Set<number>();
  for (const neuron of circuit.dopamine) {
    for (let i = graph.offsets[neuron]; i < graph.offsets[neuron + 1]; i++) {
      const target = graph.post[graph.edges[i]];
      if (output.has(target)) {
        modulated.add(target);
      }
    }
  }
  const selected: number[] = [];
  for (const neuron of circuit.kenyon) {
    for (let i = graph.offsets[neuron]; i < graph.offsets[neuron + 1]; i++) {
      const edge = graph.edges[i];
      if (modulated.has(graph.post[edge]) && graph.weights[edge] > 0) {
        selected.push(edge);
      }
    }
  }
  return Uint32Array.from(selected);
}

export function decimalColumns(left: string, right: string) {
  if (![left, right].every((value) => /^\d+$/.test(value))) {
    throw Error("Expected unsigned decimal operands");
  }
  return Array.from(
    { length: Math.max(left.length, right.length) },
    (_, column) =>
      [
        Number(left.at(-column - 1) ?? "0"),
        Number(right.at(-column - 1) ?? "0"),
      ] as const,
  );
}

export function expressionColumns(expression: string) {
  const match = /^(\d+)([+*/-])(\d+)$/.exec(expression);
  if (!match) {
    throw Error("Expected a decimal arithmetic expression");
  }
  return { operation: match[2], columns: decimalColumns(match[1], match[3]) };
}

export function selectAction(costs: readonly number[], random: () => number) {
  if (!costs.length || costs.some((cost) => !Number.isFinite(cost))) {
    throw Error("Expected finite action costs");
  }
  const minimum = Math.min(...costs);
  const weights = costs.map((cost) => Math.exp(minimum - cost));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const sample = random();
  if (!(sample >= 0 && sample < 1)) {
    throw Error("Expected a sample between zero inclusive and one exclusive");
  }
  let draw = sample * total;
  for (let action = 0; action < weights.length; action++) {
    draw -= weights[action];
    if (draw < 0 || action === weights.length - 1) {
      return { action, confidence: weights[action] / total };
    }
  }
  throw Error("Invalid action sample");
}

export class RewardPlasticity {
  readonly indices: Uint32Array;
  readonly graph: BrainGraph;
  readonly rate: number;
  readonly graphHash: string;
  private readonly initial: Float64Array;
  private readonly outgoing = new Set<number>();
  private readonly source: Uint32Array;
  private readonly pre: Float64Array;
  private readonly preTime: Int32Array;
  private tick = 0;
  private baseline = 0.5;

  constructor(graph: BrainGraph, indices: Uint32Array, { rate = 0.05 } = {}) {
    if (
      !indices.length ||
      new Set(indices).size !== indices.length ||
      indices.some(
        (i) => i >= graph.weights.length || !(graph.weights[i] > 0),
      ) ||
      !Number.isFinite(rate) ||
      rate < 0 ||
      rate > 0.5
    ) {
      throw Error("Invalid plastic synapses or learning rate");
    }
    this.graph = graph;
    this.indices = indices.slice();
    this.rate = rate;
    this.initial = Float64Array.from(indices, (i) => graph.weights[i]);
    const hash = createHash("sha256");
    for (const values of [
      graph.offsets,
      graph.edges,
      graph.post,
      graph.weights,
    ]) {
      hash.update(
        new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
      );
    }
    this.graphHash = hash.digest("hex");
    this.source = new Uint32Array(indices.length);
    const lookup = new Map(Array.from(indices, (edge, slot) => [edge, slot]));
    for (let neuron = 0; neuron < graph.offsets.length - 1; neuron++) {
      for (let i = graph.offsets[neuron]; i < graph.offsets[neuron + 1]; i++) {
        const edge = graph.edges[i];
        const slot = lookup.get(edge);
        if (slot === undefined) {
          continue;
        }
        this.source[slot] = neuron;
        this.outgoing.add(neuron);
      }
    }
    const population = graph.offsets.length - 1;
    this.pre = new Float64Array(population);
    this.preTime = new Int32Array(population);
  }

  reset() {
    this.pre.fill(0);
    this.preTime.fill(0);
    this.tick = 0;
  }

  private trace(neuron: number) {
    return (
      this.pre[neuron] * Math.exp(-(this.tick - this.preTime[neuron]) / 5000)
    );
  }

  step = (
    _spikes: readonly number[],
    arrivals: readonly number[],
    tick: number,
  ) => {
    if (!Number.isInteger(tick) || tick < this.tick || tick > 2 ** 31 - 1) {
      throw Error("Non-monotonic plasticity clock");
    }
    this.tick = tick;
    for (const neuron of arrivals) {
      if (this.outgoing.has(neuron)) {
        this.pre[neuron] = this.trace(neuron) + 1;
        this.preTime[neuron] = tick;
      }
    }
  };

  reward(
    value: number,
    targets?: readonly number[],
    expectation = this.baseline,
  ) {
    if (
      ![value, expectation].every(
        (item) => Number.isFinite(item) && item >= 0 && item <= 1,
      )
    ) {
      throw Error("Reward and expectation must be between zero and one");
    }
    const predictionError = value - expectation;
    this.baseline += 0.05 * (value - this.baseline);
    const action = targets ? new Set(targets) : undefined;
    let changed = 0;
    for (let slot = 0; slot < this.indices.length; slot++) {
      const edge = this.indices[slot];
      if (action && !action.has(this.graph.post[edge])) {
        continue;
      }
      const trace = this.trace(this.source[slot]);
      const update =
        (-this.rate * this.initial[slot] * predictionError * trace) /
        (1 + trace);
      const next = Math.max(
        this.initial[slot] * 0.05,
        Math.min(this.initial[slot] * 3, this.graph.weights[edge] + update),
      );
      changed += Number(next !== this.graph.weights[edge]);
      this.graph.weights[edge] = next;
    }
    return { predictionError, changed };
  }

  checkpoint() {
    const metadata = new TextEncoder().encode(
      JSON.stringify({
        format: "fly-plasticity-v2",
        graph: this.graphHash,
        rate: this.rate,
        baseline: this.baseline,
      }),
    );
    const weights = Float64Array.from(
      this.indices,
      (i) => this.graph.weights[i],
    );
    return encodeArchive({
      metadata: { data: metadata, shape: [metadata.length], dtype: "<u1" },
      indices: {
        data: this.indices,
        shape: [this.indices.length],
        dtype: "<u4",
      },
      weights: { data: weights, shape: [weights.length], dtype: "<f8" },
    });
  }

  static restore(graph: BrainGraph, bytes: Uint8Array) {
    const arrays = decodeArchive(bytes);
    if (
      !(arrays.metadata?.data instanceof Uint8Array) ||
      !(arrays.indices?.data instanceof Uint32Array) ||
      !(arrays.weights?.data instanceof Float64Array) ||
      arrays.indices.data.length !== arrays.weights.data.length
    ) {
      throw Error("Invalid plasticity checkpoint arrays");
    }
    const metadata = JSON.parse(
      new TextDecoder().decode(arrays.metadata.data),
    ) as { format: string; graph: string; rate: number; baseline: number };
    const learner = new RewardPlasticity(graph, arrays.indices.data, {
      rate: metadata.rate,
    });
    if (
      metadata.format !== "fly-plasticity-v2" ||
      metadata.graph !== learner.graphHash ||
      !Number.isFinite(metadata.baseline) ||
      metadata.baseline < 0 ||
      metadata.baseline > 1 ||
      arrays.weights.data.some(
        (value, i) =>
          !Number.isFinite(value) ||
          value < learner.initial[i] * 0.05 ||
          value > learner.initial[i] * 3,
      )
    ) {
      throw Error("Incompatible plasticity checkpoint");
    }
    for (let i = 0; i < learner.indices.length; i++) {
      graph.weights[learner.indices[i]] = arrays.weights.data[i];
    }
    learner.baseline = metadata.baseline;
    return learner;
  }
}
