import assert from "node:assert/strict";
import test from "node:test";
import {
  balancedSequenceSampler,
  sequenceSplit,
} from "../scripts/sequence-data.ts";

test("symbol sequences preserve all operations and keep inverse families out of fitting", () => {
  const split = sequenceSplit();
  const groups = new Set(split.training.map((r) => r.family));

  for (const name of ["validation", "test", "extrapolation"] as const) {
    for (const row of split[name]) {
      assert.ok(!groups.has(row.family));
      assert.match(row.expression, /^\d+[+*/-]\d+$/);
      assert.match(row.answer, /^\d+$/);
    }
  }

  assert.deepEqual(
    new Set(split.training.map((r) => r.operation)),
    new Set(["+", "-", "*", "/"]),
  );

  assert.equal(split.training.length, 224);
  assert.equal(split.validation.length, 78);
  assert.equal(split.test.length, 88);
  assert.equal(split.extrapolation.length, 324);
  assert.ok(split.extrapolation.some((r) => r.answer.length >= 3));

  assert.ok(
    split.training.some((r) => r.expression === "9*9" && r.answer === "81") ||
      split.validation.some(
        (r) => r.expression === "9*9" && r.answer === "81",
      ) ||
      split.test.some((r) => r.expression === "9*9" && r.answer === "81"),
  );
});

test("default-range curriculum balances operations and separates every factor family", () => {
  const split = sequenceSplit("zetamac");
  const groups = new Set<string>();

  for (const [name, count] of [
    ["training", 512],
    ["validation", 48],
    ["test", 64],
    ["extrapolation", 81],
  ] as const) {
    const rows = split[name];
    assert.equal(rows.length, count * 4);
    const current = new Set(rows.map((row) => row.family));

    for (const family of current) {
      assert.ok(!groups.has(family));
      groups.add(family);
    }

    for (const operation of ["+", "-", "*", "/"]) {
      assert.equal(
        rows.filter((row) => row.operation === operation).length,
        count,
      );
    }

    assert.equal(new Set(rows.map((row) => row.expression)).size, rows.length);
  }

  assert.ok(split.training.some((row) => row.answer.length >= 3));
  assert.ok(split.extrapolation.some((row) => row.answer.length >= 5));
  assert.deepEqual(sequenceSplit("zetamac"), split);
  assert.throws(() => sequenceSplit("unknown"));
});

test("default-range inverses match Zetamac’s left-factor reversal", async () => {
  const { arithmeticQuestions } = await import("../scripts/arithmetic-data.ts");
  const division = arithmeticQuestions(10, 66, "left").find(
    (row) => row.operation === "/",
  )!;
  assert.deepEqual([division.a, division.b, division.answer], [660, 10, 66]);
  const subtraction = arithmeticQuestions(63, 75, "left").find(
    (row) => row.operation === "-",
  )!;
  assert.deepEqual(
    [subtraction.a, subtraction.b, subtraction.answer],
    [138, 63, 75],
  );

  for (const rows of Object.values(sequenceSplit("zetamac")).slice(0, 3)) {
    for (const row of rows.filter((row) => row.operation === "/")) {
      const divisor = Number(row.expression.split("/")[1]);
      assert.ok(divisor >= 2 && divisor <= 12);
    }
  }
});

test("full default-range training retains the complete partition and evaluation separation", () => {
  const sampled = sequenceSplit("zetamac");
  const full = sequenceSplit("zetamac", true);
  const expressions = new Set(full.training.map((row) => row.expression));
  const families = new Set(full.training.map((row) => row.family));

  assert.ok(full.training.length > sampled.training.length * 4);
  assert.ok(sampled.training.every((row) => expressions.has(row.expression)));
  assert.ok(full.validation.length > sampled.validation.length);
  assert.ok(full.test.length > sampled.test.length);
  assert.ok(full.validation.every((row) => !families.has(row.family)));
  assert.ok(full.test.every((row) => !families.has(row.family)));
  assert.ok(full.training.every((row) => Number.isFinite(Number(row.answer))));
});

test("balanced sampling visits every row before repeating within an operation", () => {
  const rows = ["+", "-", "*", "/"].flatMap((operation, op) =>
    Array.from({ length: op + 2 }, (_, id) => ({ operation, id })),
  );
  const sample = balancedSequenceSampler(rows, 44);
  const repeat = balancedSequenceSampler(rows, 44);
  const batches = Array.from({ length: 5 }, () => sample(4));
  assert.deepEqual(
    batches,
    Array.from({ length: 5 }, () => repeat(4)),
  );
  for (const batch of batches) {
    assert.deepEqual(
      batch.map((row) => row.operation),
      ["+", "-", "*", "/"],
    );
  }
  for (const index of [0, 1, 2, 3]) {
    const cycle = batches.slice(0, index + 2).map((batch) => batch[index].id);
    assert.equal(new Set(cycle).size, index + 2);
  }
  assert.throws(() =>
    balancedSequenceSampler(
      rows.filter((row) => row.operation !== "/"),
      44,
    ),
  );
  assert.throws(() => sample(0));
});

test("default memorisation covers the complete finite pool and labels its repeated evaluation", async () => {
  const { memorizationSplit } = await import("../scripts/sequence-data.ts");
  const data = memorizationSplit();
  const capped = memorizationSplit(8000);
  assert.equal(capped.training.length, 8000);
  assert.equal(
    new Set(capped.training.map((row) => row.expression)).size,
    8000,
  );
  assert.throws(() => memorizationSplit(3));
  const expressions = new Set(data.training.map((row) => row.expression));
  const full = sequenceSplit("zetamac", true);
  const expected = new Set(
    [...full.training, ...full.validation, ...full.test].map(
      (row) => row.expression,
    ),
  );
  assert.deepEqual(expressions, expected);
  assert.equal(data.training.length, expressions.size);
  assert.ok(data.validation.every((row) => expressions.has(row.expression)));
  assert.ok(data.test.every((row) => expressions.has(row.expression)));
  for (const operation of ["+", "-", "*", "/"]) {
    assert.equal(
      data.validation.filter((row) => row.operation === operation).length,
      16,
    );
  }
});
