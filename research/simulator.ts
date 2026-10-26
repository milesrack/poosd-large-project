import { performance } from "node:perf_hooks";
import type { BrainGraph } from "../server/brain/graph.ts";

export interface ObservationOptions {
  onProgress?: (neural: NeuralActivity, through: number) => void;
  quiet?: boolean;
  durationMs?: number;
  encoding?: string;
  pattern?: string;
  random?: () => number;
  reset?: boolean;
  onStep?: (
    spikes: readonly number[],
    arrivals: readonly number[],
    tick: number,
  ) => void;
}

import { loadGraph } from "../server/brain/graph.ts";
import type { NeuralActivity } from "../shared/contracts.ts";

const DT = 0.0001;
const TAU = 0.005;
const MEMBRANE = 0.02;
const REST = -0.052;
const THRESHOLD = -0.045;
const G = Math.exp(-DT / TAU);
const V = Math.exp(-DT / MEMBRANE);
const BASE = REST - REST * V;
// Preserve Brian2's generated linear state updater, including operation order.
const COUPLING =
  (TAU / (MEMBRANE - TAU)) *
  (-Math.exp(DT / MEMBRANE) + Math.exp(DT / TAU)) *
  Math.exp(-DT / MEMBRANE) *
  Math.exp(-DT / TAU);

export class Brain {
  declare inputs: number[];
  declare offsets: Uint32Array;
  declare edges: Uint32Array;
  declare post: Uint32Array;
  declare weights: Float64Array;
  declare size: number;
  declare connections: number;
  declare inputSet: Set<number>;
  declare neural?: NeuralActivity;
  readonly thresholds?: Float64Array;
  private state?: {
    v: Float64Array;
    g: Float64Array;
    last: Int32Array;
    active: number[];
    marked: Uint8Array;
    queue: number[][];
    tick: number;
  };

  static async create() {
    return new Brain(await loadGraph());
  }

  constructor(graph: BrainGraph, thresholds?: Float64Array) {
    Object.assign(this, graph);
    this.size = graph.offsets.length - 1;
    this.connections = graph.edges.length;
    this.inputSet = new Set(this.inputs);
    if (
      thresholds &&
      (thresholds.length !== this.size ||
        thresholds.some(
          (value) => !Number.isFinite(value) || value <= REST || value >= 0,
        ))
    ) {
      throw Error("Invalid cell thresholds");
    }
    this.thresholds = thresholds?.slice();
  }

  observe(
    a: number,
    b: number,
    {
      onProgress,
      quiet = false,
      durationMs = 250,
      encoding = "rate",
      pattern = "regular",
      random = Math.random,
    }: ObservationOptions = {},
  ) {
    if (
      ![a, b].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 9,
      ) ||
      !["rate", "population"].includes(encoding) ||
      !["regular", "poisson"].includes(pattern) ||
      !(durationMs > 0 && durationMs <= 1000)
    ) {
      throw Error("Invalid neural stimulus");
    }

    const stimuli = this.inputs.slice(0, 20).map((neuron, channel) => {
      const operand = channel < 10 ? a : b;
      const rate = quiet
        ? 0
        : encoding === "rate"
          ? 25 + (125 * operand) / 9
          : 150 * Math.max(0, Math.min(1, operand - (channel % 10)));
      return { neuron, rate };
    });
    const result = this.stimulate(stimuli, {
      onProgress,
      durationMs,
      pattern,
      random,
    });
    for (const index of this.inputs) {
      result.counts[index] = 0;
    }
    return result;
  }

  reset() {
    this.state = undefined;
  }

  stimulate(
    stimuli: { neuron: number; rate: number }[],
    {
      onProgress,
      durationMs = 250,
      pattern = "poisson",
      random = Math.random,
      reset = true,
      onStep,
    }: ObservationOptions = {},
  ) {
    if (
      !(durationMs > 0 && durationMs <= 1000) ||
      !["regular", "poisson"].includes(pattern) ||
      stimuli.some(
        ({ neuron, rate }) =>
          !Number.isInteger(neuron) ||
          neuron < 0 ||
          neuron >= this.size ||
          !Number.isFinite(rate) ||
          rate < 0 ||
          rate > 1000,
      )
    ) {
      throw Error("Invalid spiking stimulus");
    }
    const started = performance.now();
    const ticks = Math.round(durationMs / 0.1);
    const events = Array.from({ length: ticks }, (): number[] => []);
    for (const [channel, { neuron, rate }] of stimuli.entries()) {
      if (pattern === "regular" && rate) {
        for (
          let pulse = 0;
          pulse < Math.ceil((durationMs * rate) / 1000);
          pulse++
        ) {
          const ms = ((pulse + (channel + 0.5) / stimuli.length) * 1000) / rate;
          const tick = Math.floor(ms / 0.1 + 0.001);
          if (tick < ticks) {
            events[tick].push(neuron);
          }
        }
      } else if (pattern === "poisson") {
        for (let tick = 0; tick < ticks; tick++) {
          if (random() < rate * DT) {
            events[tick].push(neuron);
          }
        }
      }
    }
    if (reset || !this.state) {
      this.state = {
        v: new Float64Array(this.size).fill(REST),
        g: new Float64Array(this.size),
        last: new Int32Array(this.size).fill(-100000),
        active: [],
        marked: new Uint8Array(this.size),
        queue: Array.from({ length: 19 }, () => []),
        tick: 0,
      };
    }
    const { v, g, last, active, marked, queue } = this.state;
    const startTick = this.state.tick;
    const counts = new Float32Array(this.size);
    const spikes: [number, number][] = [];
    const touch = (index: number) => {
      if (!marked[index]) {
        marked[index] = 1;
        active.push(index);
      }
    };
    const report = (through: number) =>
      onProgress?.(
        {
          spikes,
          inputs: this.inputs,
          totalSpikes: spikes.length,
          population: this.size,
          durationMs,
        },
        through,
      );

    for (let localTick = 0; localTick < ticks; localTick++) {
      const tick = startTick + localTick;
      const firing = [];

      for (let n = 0; n < active.length; n++) {
        const i = active[n];

        if (tick - last[i] < (this.inputSet.has(i) ? 0 : 22)) {
          continue;
        }

        v[i] = BASE + (COUPLING * g[i] + V * v[i]);
        g[i] = G * g[i];

        if (v[i] > (this.thresholds?.[i] ?? THRESHOLD)) {
          firing.push(i);
          last[i] = tick;
          counts[i]++;
        }
      }

      firing.sort((a, b) => a - b);

      for (const index of firing) {
        spikes.push([index, localTick * 0.1]);
      }

      // Brian schedules thresholds, synaptic delivery, then reset in each timestep.
      for (const source of firing) {
        queue[(tick + 18) % 19].push(source);
      }

      for (const source of queue[tick % 19]) {
        for (
          let offset = this.offsets[source];
          offset < this.offsets[source + 1];
          offset++
        ) {
          const edge = this.edges[offset];
          const target = this.post[edge];

          if (
            last[target] !== tick &&
            tick - last[target] >= (this.inputSet.has(target) ? 0 : 22)
          ) {
            touch(target);
            g[target] += this.weights[edge];
          }
        }
      }

      onStep?.(firing, queue[tick % 19], tick);
      queue[tick % 19] = [];

      for (const target of events[localTick]) {
        touch(target);
        v[target] += 0.06875;
      }

      for (const index of firing) {
        v[index] = REST;
        g[index] = 0;
      }

      if ((localTick + 1) % 500 === 0 && localTick + 1 < ticks) {
        report((localTick + 1) * 0.1);
      }
    }

    this.state.tick += ticks;

    this.neural = {
      spikes,
      inputs: this.inputs,
      totalSpikes: spikes.length,
      population: this.size,
      durationMs,
    };

    onProgress?.(this.neural, durationMs);

    return { counts, seconds: (performance.now() - started) / 1000 };
  }
}
