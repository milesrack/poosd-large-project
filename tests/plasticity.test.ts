import assert from "node:assert/strict";
import test from "node:test";
import {
  decimalColumns,
  plasticConnections,
  RewardPlasticity,
} from "../research/plasticity.ts";
import type { BrainGraph } from "../server/brain/graph.ts";

function graph(): BrainGraph {
  return {
    inputs: [0],
    offsets: Uint32Array.of(0, 2, 2, 2, 3),
    edges: Uint32Array.of(0, 1, 2),
    post: Uint32Array.of(1, 2, 1),
    weights: Float64Array.of(0.02, -0.03, 0.01),
  };
}

test("plastic connections require positive Kenyon input and anatomical dopamine coverage", () => {
  assert.deepEqual(
    Array.from(
      plasticConnections(graph(), {
        kenyon: [0],
        output: [1, 2],
        dopamine: [3],
      }),
    ),
    [0],
  );
});

test("local eligibility and scalar feedback change only eligible weights and preserve signs", () => {
  const network = graph();
  const learner = new RewardPlasticity(network, Uint32Array.of(0), {
    rate: 0.1,
  });
  const initial = network.weights.slice();
  learner.step([], [0], 0);
  learner.step([1], [], 10);
  assert.deepEqual(network.weights, initial);
  assert.ok(learner.reward(1).changed > 0);
  assert.ok(network.weights[0] < initial[0]);
  assert.deepEqual(network.weights.slice(1), initial.slice(1));
  for (let i = 0; i < 1000; i++) {
    learner.reward(1);
  }
  assert.ok(network.weights[0] <= initial[0] * 3);
  assert.ok(network.weights[0] > 0);
  assert.throws(() => learner.reward(Number.NaN));
  assert.throws(() => learner.step([], [], 5));
});

test("silent, frozen, and reset traces cannot fabricate synaptic learning", () => {
  for (const rate of [0, 0.1]) {
    const network = graph();
    const learner = new RewardPlasticity(network, Uint32Array.of(0), { rate });
    const initial = network.weights.slice();
    learner.reward(1);
    assert.deepEqual(network.weights, initial);
    learner.step([], [0], 0);
    learner.step([1], [], 10);
    if (rate === 0) {
      learner.reward(1, [1]);
      assert.deepEqual(network.weights, initial);
    }
    learner.reset();
    learner.reward(1);
    assert.deepEqual(network.weights, initial);
  }
});

test("plasticity checkpoints restore bounded numerical changes and reject a different graph", () => {
  const network = graph();
  const learner = new RewardPlasticity(network, Uint32Array.of(0), {
    rate: 0.1,
  });
  learner.step([], [0], 0);
  learner.step([1], [], 10);
  learner.reward(1);
  const copy = graph();
  const restored = RewardPlasticity.restore(copy, learner.checkpoint());
  assert.deepEqual(copy.weights, network.weights);
  assert.deepEqual(restored.indices, learner.indices);
  const different = graph();
  different.weights[1] *= 2;
  assert.throws(() =>
    RewardPlasticity.restore(different, learner.checkpoint()),
  );
});

test("column presentation only aligns and pads input digits", () => {
  assert.deepEqual(decimalColumns("47", "8"), [
    [7, 8],
    [4, 0],
  ]);
  assert.deepEqual(decimalColumns("999", "1"), [
    [9, 1],
    [9, 0],
    [9, 0],
  ]);
  assert.throws(() => decimalColumns("-1", "2"));
});

test("dopamine pairing does not require a postsynaptic spike and is action-local", () => {
  const network = graph();
  network.weights[1] = 0.03;
  const learner = new RewardPlasticity(network, Uint32Array.of(0, 1), {
    rate: 0.1,
  });
  learner.step([], [0], 0);
  learner.step([], [], 10);
  learner.reward(1, [1]);
  assert.ok(network.weights[0] < 0.02);
  assert.equal(network.weights[1], 0.03);
  const rewarded = network.weights[0];
  learner.reward(0, [1]);
  assert.ok(network.weights[0] > rewarded);
});

test("an unrewarded first action can be discouraged without a prior successful answer", () => {
  const network = graph();
  const learner = new RewardPlasticity(network, Uint32Array.of(0), {
    rate: 0.1,
  });
  learner.step([], [0], 0);
  learner.reward(0, [1]);
  assert.ok(network.weights[0] > 0.02);
});

test("reward prediction can follow neural confidence and rejects invalid expectations", () => {
  const network = graph();
  const learner = new RewardPlasticity(network, Uint32Array.of(0), {
    rate: 0.1,
  });
  learner.step([], [0], 0);
  assert.equal(learner.reward(1, [1], 1).changed, 0);
  assert.equal(network.weights[0], 0.02);
  assert.equal(learner.reward(0, [1], 0.8).predictionError, -0.8);
  assert.ok(network.weights[0] > 0.02);
  const before = network.weights.slice();
  for (const invalid of [-0.1, 1.1, Number.NaN]) {
    assert.throws(() => learner.reward(1, [1], invalid));
    assert.deepEqual(network.weights, before);
  }
});

test("expression columns preserve every operator and digit without computing an answer", async () => {
  const { expressionColumns } = await import("../research/plasticity.ts");
  for (const operation of ["+", "-", "*", "/"]) {
    assert.deepEqual(expressionColumns(`1200${operation}12`), {
      operation,
      columns: [
        [0, 2],
        [0, 1],
        [2, 0],
        [1, 0],
      ],
    });
  }
  for (const invalid of ["1", "2^3", "1+2+3", "2.5*4", "1/0x10"]) {
    assert.throws(() => expressionColumns(invalid));
  }
});

test("probabilistic action selection explores alternatives to a silent cheapest group", async () => {
  const { selectAction } = await import("../research/plasticity.ts");
  const { randomSource } = await import("../server/brain/random.ts");
  const random = randomSource(50);
  const counts = [0, 0, 0];
  for (let i = 0; i < 4096; i++) {
    const { action, confidence } = selectAction([0, 1, 2], random);
    counts[action]++;
    const weights = [1, Math.exp(-1), Math.exp(-2)];
    assert.ok(
      Math.abs(
        confidence - weights[action] / weights.reduce((a, b) => a + b, 0),
      ) < 1e-12,
    );
  }
  assert.ok(counts.every((count) => count > 0));
  assert.ok(Math.abs(counts[0] / 4096 - 0.66524) < 0.03);
  assert.deepEqual(
    selectAction([1000, 1001, 1002], () => 0.99),
    selectAction([0, 1, 2], () => 0.99),
  );
  assert.throws(() => selectAction([0, 1], () => 1));
  assert.throws(() => selectAction([0, 1], () => Number.NaN));
  for (const invalid of [[], [Number.NaN], [Number.POSITIVE_INFINITY]]) {
    assert.throws(() => selectAction(invalid, random));
  }
});
