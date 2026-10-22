import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { NeuralActivity } from "../../shared/contracts.ts";
import { sampleNeurons } from "../../shared/neural.ts";
import { decodeArchive, encodeArchive } from "./arrays.ts";
import { encodeExpression, POSITION_FEATURES } from "./expression.ts";
import type { BrainGraph } from "./graph.ts";
import type { ArithmeticAction, ArithmeticPolicy } from "./policy.ts";
import { decodePolicy, validateExpression } from "./policy.ts";
import { randomSource } from "./random.ts";
import { backpropReadout, readout, readoutSize } from "./readout.ts";

const INPUTS = "0123456789+-*/=";
const OUTPUTS = "0123456789-\n";

export interface SequenceOptions {
  seed: number;
  sensory: number[];
  readout: number[];
  steps: number;
  settle: number;
  maxKeys: number;
  anatomySha256: string;
  coupling?: number;
  hidden?: number;
  encoding?: "symbols" | "place";
}

export interface SequenceExample {
  expression: string;
  answer: string;
}

export interface KeyExample {
  features: Float64Array;
  key: number;
}

interface Frame {
  token: number;
  position?: number[];
  previous: Float64Array;
  sums: Float64Array;
  activation: Float64Array;
}

export class SequenceBrain implements ArithmeticPolicy {
  readonly parameters: Float64Array;
  readonly mean: Float64Array;
  readonly scale: Float64Array;
  readonly embeddingStart: number;
  readonly headStart: number;
  readonly positionStart: number;
  readonly graphSha256: string;
  readonly options: SequenceOptions & { coupling: number; hidden: number };
  private readonly weights: Float32Array;
  private readonly targets: Uint32Array;
  private readonly first: Float64Array;
  private readonly second: Float64Array;
  private readonly population: number;
  private state: Float64Array;
  private previous = "=";
  private generated = "";
  private rejected = new Set<string>();
  private plan: string | undefined;
  private remaining = 0;
  private updates = 0;
  internalUpdates = 0;
  headUpdates = 0;
  readonly graph: BrainGraph;

  constructor(
    graph: BrainGraph,
    options: SequenceOptions,
    { inference = false } = {},
  ) {
    this.graph = graph;
    const n = graph.offsets.length - 1;
    const coupling = options.coupling ?? 0.25;
    const hidden = options.hidden ?? 0;

    if (
      !Number.isInteger(hidden) ||
      hidden < 0 ||
      hidden > 256 ||
      (hidden > 0 && options.encoding !== "place") ||
      !Number.isFinite(coupling) ||
      coupling < 0.1 ||
      coupling > 4 ||
      !Number.isSafeInteger(options.seed) ||
      !Number.isInteger(options.steps) ||
      options.steps < 1 ||
      options.steps > 4 ||
      !Number.isInteger(options.settle) ||
      options.settle < 0 ||
      options.settle > 16 ||
      !Number.isInteger(options.maxKeys) ||
      options.maxKeys < 2 ||
      options.maxKeys > 256 ||
      (options.encoding !== undefined &&
        !["symbols", "place"].includes(options.encoding)) ||
      !/^[a-f0-9]{64}$/.test(options.anatomySha256)
    ) {
      throw Error("Invalid sequence configuration");
    }

    for (const ids of [options.sensory, options.readout]) {
      if (
        !ids.length ||
        ids.length > n ||
        new Set(ids).size !== ids.length ||
        ids.some((i) => !Number.isInteger(i) || i < 0 || i >= n)
      ) {
        throw Error("Invalid sequence anatomy");
      }
    }

    this.options = {
      ...options,
      coupling,
      hidden,
      sensory: [...options.sensory],
      readout: [...options.readout],
    };

    this.population = n;
    this.state = new Float64Array(n);
    const hash = sha256.create();

    for (const array of [
      graph.offsets,
      graph.edges,
      graph.post,
      graph.weights,
    ]) {
      hash.update(
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
      );
    }

    this.graphSha256 = bytesToHex(hash.digest());
    this.embeddingStart = 2 * n;

    this.positionStart =
      this.embeddingStart + INPUTS.length * options.sensory.length;

    this.headStart =
      this.positionStart +
      (options.encoding === "place"
        ? POSITION_FEATURES * options.sensory.length
        : 0);

    this.parameters = new Float64Array(
      this.headStart +
        readoutSize(options.readout.length, OUTPUTS.length, hidden),
    );

    this.parameters.fill(1, 0, n);
    this.parameters.fill(Math.log(4), n, 2 * n); // Initial state retention is 0.8.
    const random = randomSource(options.seed);

    for (let i = this.embeddingStart; i < this.headStart; i++) {
      this.parameters[i] = (random() - 0.5) * 0.5;
    }

    if (hidden) {
      let offset = this.headStart;

      for (const [inputs, outputs] of [
        [options.readout.length, hidden],
        [hidden, OUTPUTS.length],
      ]) {
        const bound = Math.sqrt(6 / (inputs + outputs));

        for (let unit = 0; unit < outputs; unit++) {
          for (let i = 0; i < inputs; i++) {
            this.parameters[offset++] = (2 * random() - 1) * bound;
          }

          this.parameters[offset++] = 0;
        }
      }
    } else {
      for (let i = this.headStart; i < this.parameters.length; i++) {
        this.parameters[i] =
          (random() - 0.5) / Math.sqrt(options.readout.length);
      }
    }

    this.mean = new Float64Array(options.readout.length);
    this.scale = new Float64Array(options.readout.length).fill(1);
    this.first = new Float64Array(inference ? 0 : this.parameters.length);
    this.second = new Float64Array(inference ? 0 : this.parameters.length);
    const norm = new Float64Array(n);

    for (let e = 0; e < graph.post.length; e++) {
      norm[graph.post[e]] += graph.weights[e] ** 2;
    }

    const ordered = graph.edges.every((edge, index) => edge === index);
    this.targets = ordered ? graph.post : new Uint32Array(graph.edges.length);
    this.weights = new Float32Array(graph.edges.length);

    for (let index = 0; index < graph.edges.length; index++) {
      const edge = graph.edges[index];
      const target = graph.post[edge];

      if (!ordered) {
        this.targets[index] = target;
      }

      this.weights[index] = norm[target]
        ? (coupling * graph.weights[edge]) / Math.sqrt(norm[target])
        : 0;
    }
  }

  private step(token: number, frames?: Frame[], position?: number[]) {
    const previous = this.state;
    const n = this.population;
    const sums = new Float64Array(n);
    const activation = new Float64Array(n);
    const next = new Float64Array(n);
    const { offsets } = this.graph;

    for (let source = 0; source < n; source++) {
      const value = previous[source];

      if (!value) {
        continue;
      }

      for (let c = offsets[source]; c < offsets[source + 1]; c++) {
        sums[this.targets[c]] += value * this.weights[c];
      }
    }

    if (token >= 0) {
      for (let i = 0; i < this.options.sensory.length; i++) {
        sums[this.options.sensory[i]] +=
          this.parameters[
            this.embeddingStart + token * this.options.sensory.length + i
          ];
      }
    }

    if (position) {
      for (let i = 0; i < this.options.sensory.length; i++) {
        for (let j = 0; j < POSITION_FEATURES; j++) {
          sums[this.options.sensory[i]] +=
            this.parameters[
              this.positionStart + j * this.options.sensory.length + i
            ] * position[j];
        }
      }
    }

    for (let i = 0; i < n; i++) {
      const retention = 1 / (1 + Math.exp(-this.parameters[n + i]));
      activation[i] = Math.tanh(this.parameters[i] * sums[i]);
      next[i] = retention * previous[i] + (1 - retention) * activation[i];
    }

    frames?.push({ token, position, previous, sums, activation });
    this.state = next;
    this.updates++;
  }

  private token(symbol: string, frames?: Frame[], position?: number[]) {
    const id = INPUTS.indexOf(symbol);

    if (id < 0) {
      throw Error("Invalid sequence symbol");
    }

    for (let i = 0; i < this.options.steps; i++) {
      this.step(id, frames, position);
    }
  }

  private prime(expression: string, frames?: Frame[]) {
    this.resetRun();

    if (this.options.encoding === "place") {
      for (const { symbol, position } of encodeExpression(expression)) {
        this.token(symbol, frames, position);
      }
    } else {
      validateExpression(expression);

      for (const symbol of expression) {
        this.token(symbol, frames);
      }
    }

    for (let i = 0; i < this.options.settle; i++) {
      this.step(-1, frames);
    }
  }

  private observation() {
    return Float64Array.from(this.options.readout, (i) => this.state[i]);
  }

  private teacher(expression: string, answer: string, frames?: Frame[]) {
    if (!/^-?\d+$/.test(answer) || answer.length + 1 > this.options.maxKeys) {
      throw Error("Invalid answer sequence");
    }

    this.prime(expression, frames);

    return Array.from(`${answer}\n`, (symbol, i) => {
      this.token(i ? answer[i - 1] : "=", frames);

      return {
        features: this.observation(),
        key: OUTPUTS.indexOf(symbol),
        frame: frames?.length ?? 0,
      };
    });
  }

  features(expression: string, answer: string): KeyExample[] {
    return this.teacher(expression, answer);
  }

  calibrate(rows: KeyExample[]) {
    if (
      !rows.length ||
      rows.some(
        (r) =>
          r.features.length !== this.mean.length ||
          r.features.some((v) => !Number.isFinite(v)),
      )
    ) {
      throw Error("Invalid calibration data");
    }

    for (let i = 0; i < this.mean.length; i++) {
      this.mean[i] = rows.reduce((s, r) => s + r.features[i], 0) / rows.length;

      this.scale[i] = Math.max(
        1e-6,
        Math.sqrt(
          rows.reduce((s, r) => s + (r.features[i] - this.mean[i]) ** 2, 0) /
            rows.length,
        ),
      );
    }
  }

  private readout(features: Float64Array) {
    if (
      features.length !== this.mean.length ||
      features.some((v) => !Number.isFinite(v))
    ) {
      throw Error("Invalid sequence features");
    }

    return readout(
      this.parameters,
      this.headStart,
      Float64Array.from(
        features,
        (value, i) => (value - this.mean[i]) / this.scale[i],
      ),
      OUTPUTS.length,
      this.options.hidden,
    );
  }

  private logits(features: Float64Array) {
    return this.readout(features).logits;
  }

  featureLoss(row: KeyExample) {
    if (
      !Number.isInteger(row.key) ||
      row.key < 0 ||
      row.key >= OUTPUTS.length
    ) {
      throw Error("Invalid target key");
    }

    const logits = this.logits(row.features);
    const maximum = Math.max(...logits);

    return (
      maximum +
      Math.log(logits.reduce((s, v) => s + Math.exp(v - maximum), 0)) -
      logits[row.key]
    );
  }

  loss(expression: string, answer: string) {
    const rows = this.features(expression, answer);

    return (
      rows.reduce((sum, row) => sum + this.featureLoss(row), 0) / rows.length
    );
  }

  resetRun() {
    this.state.fill(0);
    this.previous = "=";
    this.generated = "";
    this.rejected.clear();
    this.plan = undefined;
    this.remaining = 0;
    this.updates = 0;
  }

  activity(): NeuralActivity {
    const ids = Array.from({ length: this.population }, (_, i) => i).filter(
      (i) => this.state[i] !== 0,
    );

    const sampled = sampleNeurons(
      ids,
      (id) => this.state[id],
      this.options.sensory,
      192,
    );

    return {
      spikes: [],
      totalSpikes: 0,
      durationMs: 0,
      population: this.population,
      activeNeurons: ids.length,
      inputs: [...this.options.sensory],
      rateSteps: this.updates,
      rates: sampled.map((id) => [id, this.updates, this.state[id]]),
    };
  }

  outputActivity() {
    return Array.from(this.options.readout, (id) => this.state[id]);
  }

  activeNeurons() {
    return this.state.reduce((count, value) => count + Number(value !== 0), 0);
  }

  beginProblem(expression: string, rejected: readonly string[] = []) {
    if (
      !Array.isArray(rejected) ||
      rejected.length > 512 ||
      rejected.some(
        (answer) =>
          typeof answer !== "string" ||
          answer.length > this.options.maxKeys ||
          !/^-?\d+$/.test(answer) ||
          !Number.isSafeInteger(Number(answer)),
      )
    ) {
      throw Error("Invalid rejected answers");
    }

    this.prime(expression);
    this.rejected = new Set(rejected.map((answer) => String(Number(answer))));
    this.remaining = this.options.maxKeys;

    if (this.rejected.size) {
      const state = this.state;
      const updates = this.updates;
      this.plan = this.alternative();
      this.state = state;
      this.updates = updates;
    }
  }

  private allowed(symbol: string, answer: string, remaining: number) {
    if (symbol === "\n") {
      return /^-?\d+$/.test(answer);
    }

    if (symbol === "-") {
      return !answer && remaining >= 2;
    }

    return remaining >= 1 && Number.isSafeInteger(Number(answer + symbol));
  }

  private alternative() {
    let beams = [{ state: this.state, answer: "", previous: "=", score: 0 }];
    let selected: string | undefined;
    let best = -Infinity;

    for (let depth = 0; depth < this.options.maxKeys && beams.length; depth++) {
      const next: typeof beams = [];
      const remaining = this.options.maxKeys - depth - 1;

      for (const beam of beams) {
        this.state = beam.state;
        this.token(beam.previous);
        const logits = this.logits(this.observation());
        const maximum = Math.max(...logits);
        const normaliser =
          maximum +
          Math.log(logits.reduce((sum, v) => sum + Math.exp(v - maximum), 0));

        for (let key = 0; key < OUTPUTS.length; key++) {
          const symbol = OUTPUTS[key];
          const score = beam.score + logits[key] - normaliser;

          if (
            !Number.isFinite(score) ||
            !this.allowed(symbol, beam.answer, remaining)
          ) {
            continue;
          }

          if (symbol === "\n") {
            if (
              !this.rejected.has(String(Number(beam.answer))) &&
              score > best
            ) {
              best = score;
              selected = beam.answer;
            }
          } else if (score > best) {
            next.push({
              state: this.state,
              answer: beam.answer + symbol,
              previous: symbol,
              score,
            });
          }
        }
      }

      beams = next.sort((a, b) => b.score - a.score).slice(0, 4);
    }

    if (selected === undefined) {
      throw Error("Model produced no alternative within its answer key budget");
    }

    return selected;
  }

  nextAction(): ArithmeticAction {
    if (!this.remaining) {
      throw Error("No active problem or key budget exhausted");
    }

    this.remaining--;
    this.token(this.previous);
    const logits = this.logits(this.observation());
    let key = -1;

    for (let j = 0; j < logits.length; j++) {
      const symbol = OUTPUTS[j];
      const planned = this.plan?.[this.generated.length] ?? "\n";
      const allowed =
        this.allowed(symbol, this.generated, this.remaining) &&
        (this.plan === undefined || symbol === planned) &&
        (symbol !== "\n" || !this.rejected.has(String(Number(this.generated))));

      if (
        allowed &&
        Number.isFinite(logits[j]) &&
        (key < 0 || logits[j] > logits[key])
      ) {
        key = j;
      }
    }

    if (key < 0) {
      throw Error("Model produced no finite numeric scores");
    }

    if (key === OUTPUTS.length - 1) {
      this.remaining = 0;

      return "end";
    }

    this.previous = OUTPUTS[key];
    this.generated += this.previous;

    return this.previous as ArithmeticAction;
  }

  get limits() {
    return {
      maxKeys: this.options.maxKeys,
    };
  }

  predict(expression: string) {
    return decodePolicy(this, expression);
  }

  private headGradient(
    row: KeyExample,
    result: Float64Array,
    divisor = 1,
    backprop = false,
  ) {
    if (
      !Number.isInteger(row.key) ||
      row.key < 0 ||
      row.key >= OUTPUTS.length
    ) {
      throw Error("Invalid target key");
    }

    const pass = this.readout(row.features);
    const logits = pass.logits;
    const maximum = Math.max(...logits);
    const values = Float64Array.from(logits, (v) => Math.exp(v - maximum));
    const total = values.reduce((s, v) => s + v, 0);
    const deltas = Float64Array.from(
      values,
      (value, key) => (value / total - Number(key === row.key)) / divisor,
    );
    const inputError = backpropReadout(
      this.parameters,
      this.headStart,
      pass,
      deltas,
      result,
    );
    const error = new Float64Array(backprop ? this.population : 0);

    if (backprop) {
      for (let i = 0; i < row.features.length; i++) {
        error[this.options.readout[i]] += inputError[i] / this.scale[i];
      }
    }

    return error;
  }

  gradient(expression: string, answer: string) {
    const frames: Frame[] = [];
    const rows = this.teacher(expression, answer, frames);
    const result = new Float64Array(this.parameters.length);
    const n = this.population;
    const errors = new Map(
      rows.map((row) => [
        row.frame,
        this.headGradient(row, result, rows.length, true),
      ]),
    );
    let error = new Float64Array(n);
    const { offsets } = this.graph;

    for (let t = frames.length - 1; t >= 0; t--) {
      const observed = errors.get(t + 1);

      if (observed) {
        for (let i = 0; i < n; i++) {
          error[i] += observed[i];
        }
      }

      const { token, position, previous, sums, activation } = frames[t];
      const preceding = new Float64Array(n);
      const delta = new Float64Array(n);

      for (let i = 0; i < n; i++) {
        const retention = 1 / (1 + Math.exp(-this.parameters[n + i]));
        const local = error[i] * (1 - retention) * (1 - activation[i] ** 2);
        result[i] += local * sums[i];

        result[n + i] +=
          error[i] *
          (previous[i] - activation[i]) *
          retention *
          (1 - retention);

        preceding[i] = error[i] * retention;
        delta[i] = local * this.parameters[i];
      }

      if (token >= 0) {
        for (let i = 0; i < this.options.sensory.length; i++) {
          result[
            this.embeddingStart + token * this.options.sensory.length + i
          ] += delta[this.options.sensory[i]];
        }
      }

      if (position) {
        for (let i = 0; i < this.options.sensory.length; i++) {
          for (let j = 0; j < POSITION_FEATURES; j++) {
            result[this.positionStart + j * this.options.sensory.length + i] +=
              delta[this.options.sensory[i]] * position[j];
          }
        }
      }

      for (let source = 0; source < n; source++) {
        for (let c = offsets[source]; c < offsets[source + 1]; c++) {
          preceding[source] += delta[this.targets[c]] * this.weights[c];
        }
      }

      error = preceding;
    }

    return result;
  }

  private update(gradient: Float64Array, rate: number, mode: "joint" | "head") {
    if (this.first.length !== this.parameters.length) {
      throw Error("Warm-start inference weights before training");
    }

    if (
      !Number.isFinite(rate) ||
      rate <= 0 ||
      rate > 0.1 ||
      gradient.some((v) => !Number.isFinite(v))
    ) {
      throw Error("Invalid sequence update");
    }

    this.headUpdates++;

    if (mode === "joint") {
      this.internalUpdates++;
    }

    for (
      let i = mode === "head" ? this.headStart : 0;
      i < gradient.length;
      i++
    ) {
      const g = Math.max(-1, Math.min(1, gradient[i]));
      const age = i < this.headStart ? this.internalUpdates : this.headUpdates;
      this.first[i] = 0.9 * this.first[i] + 0.1 * g;
      this.second[i] = 0.999 * this.second[i] + 0.001 * g * g;

      this.parameters[i] -=
        (rate * (this.first[i] / (1 - 0.9 ** age))) /
        (Math.sqrt(this.second[i] / (1 - 0.999 ** age)) + 1e-8);

      if (i < this.population) {
        this.parameters[i] = Math.max(0.1, Math.min(4, this.parameters[i]));
      } else {
        this.parameters[i] = Math.max(-10, Math.min(10, this.parameters[i]));
      }
    }
  }

  learnFeatures(rows: KeyExample[], rate = 0.003) {
    if (!rows.length) {
      throw Error("Empty sequence batch");
    }

    const gradient = new Float64Array(this.parameters.length);

    for (const row of rows) {
      this.headGradient(row, gradient, rows.length);
    }

    this.update(gradient, rate, "head");
  }

  learn(
    rows: SequenceExample[],
    rate = 0.003,
    mode: "joint" | "head" = "joint",
  ) {
    if (!rows.length) {
      throw Error("Empty sequence batch");
    }

    if (mode === "head") {
      return this.learnFeatures(
        rows.flatMap((r) => this.features(r.expression, r.answer)),
        rate,
      );
    }

    const gradient = new Float64Array(this.parameters.length);

    for (const row of rows) {
      const sample = this.gradient(row.expression, row.answer);

      for (let i = 0; i < gradient.length; i++) {
        gradient[i] += sample[i] / rows.length;
      }
    }

    this.update(gradient, rate, mode);
  }

  checkpoint() {
    return encodeArchive({
      format_version: {
        data: this.options.hidden
          ? 10
          : this.options.encoding === "place"
            ? 9
            : 8,
      },
      config: {
        data: [
          this.options.seed,
          this.options.steps,
          this.options.settle,
          this.options.maxKeys,
          this.options.coupling,
          ...(this.options.hidden ? [this.options.hidden] : []),
        ],
        shape: [this.options.hidden ? 6 : 5],
        dtype: "<f8",
      },
      sensory: {
        data: this.options.sensory,
        shape: [this.options.sensory.length],
        dtype: "<u4",
      },
      readout: {
        data: this.options.readout,
        shape: [this.options.readout.length],
        dtype: "<u4",
      },
      anatomy_sha256: {
        data: hexToBytes(this.options.anatomySha256),
        shape: [32],
        dtype: "<u1",
      },
      graph_sha256: {
        data: hexToBytes(this.graphSha256),
        shape: [32],
        dtype: "<u1",
      },
      ages: {
        data: [this.internalUpdates, this.headUpdates],
        shape: [2],
        dtype: "<f8",
      },
      ...Object.fromEntries(
        (["parameters", "mean", "scale", "first", "second"] as const)
          .filter((name) => this[name].length)
          .map((name) => [
            name,
            { data: this[name], shape: [this[name].length], dtype: "<f8" },
          ]),
      ),
    });
  }

  static restore(
    graph: BrainGraph,
    bytes: Uint8Array,
    { inference = false } = {},
  ) {
    const archive = decodeArchive(bytes);

    if (!inference && (!archive.first || !archive.second)) {
      throw Error(
        "Resuming training requires optimiser state; use the training .npz checkpoint",
      );
    }

    const array = (name: string) => {
      const row = archive[name];

      if (!row || typeof row.data === "string") {
        throw Error("Invalid sequence checkpoint");
      }

      return row.data;
    };
    const version = array("format_version")[0];

    if (!(
      (version === 7 && array("config").length === 4) ||
      (version === 8 && array("config").length === 5) ||
      (version === 9 && array("config").length === 5) ||
      (version === 10 && array("config").length === 6)
    )) {
      throw Error("Invalid sequence format");
    }

    const [seed, steps, settle, maxKeys, coupling = 0.25, hidden = 0] =
      array("config");
    if (version === 10 && !hidden) {
      throw Error("Invalid hidden readout width");
    }

    const sensory = Array.from(array("sensory"));
    const readoutIds = Array.from(array("readout"));
    const headStart =
      2 * (graph.offsets.length - 1) +
      sensory.length * (INPUTS.length + (version >= 9 ? POSITION_FEATURES : 0));

    if (
      array("parameters").length !==
      headStart + readoutSize(readoutIds.length, OUTPUTS.length, hidden)
    ) {
      throw Error("Invalid sequence parameter dimensions");
    }

    const model = new SequenceBrain(
      graph,
      {
        seed,
        steps,
        settle,
        maxKeys,
        coupling,
        hidden,
        encoding: version >= 9 ? "place" : "symbols",
        sensory,
        readout: readoutIds,
        anatomySha256: bytesToHex(Uint8Array.from(array("anatomy_sha256"))),
      },
      { inference },
    );

    if (
      bytesToHex(Uint8Array.from(array("graph_sha256"))) !== model.graphSha256
    ) {
      throw Error("Sequence graph mismatch");
    }

    const ages = array("ages");

    if (
      ages.length !== 2 ||
      ages.some((v) => !Number.isSafeInteger(v) || v < 0) ||
      ages[0] > ages[1]
    ) {
      throw Error("Invalid optimiser ages");
    }

    for (const name of [
      "parameters",
      "mean",
      "scale",
      "first",
      "second",
    ] as const) {
      if (inference && (name === "first" || name === "second")) {
        continue;
      }

      const values = array(name);

      if (
        values.length !== model[name].length ||
        values.some((v) => !Number.isFinite(v))
      ) {
        throw Error("Invalid sequence arrays");
      }

      model[name].set(values);
    }

    if (
      model.scale.some((v) => v < 1e-6) ||
      model.second.some((v) => v < 0) ||
      model.parameters
        .subarray(0, model.population)
        .some((v) => v < 0.1 || v > 4) ||
      model.parameters.subarray(model.population).some((v) => Math.abs(v) > 10)
    ) {
      throw Error("Invalid sequence bounds");
    }

    [model.internalUpdates, model.headUpdates] = ages;

    return model;
  }
}
