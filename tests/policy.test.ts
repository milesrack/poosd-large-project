import assert from "node:assert/strict";
import test from "node:test";
import { type ArithmeticPolicy, runPolicy } from "../server/brain/policy.ts";

function policy(keys: unknown[], maxKeys = keys.length): ArithmeticPolicy {
  let index = 0;

  return {
    limits: { maxKeys },
    resetRun() {
      index = 0;
    },
    beginProblem() {
      index = 0;
    },
    nextAction() {
      return keys[index++] as ReturnType<ArithmeticPolicy["nextAction"]>;
    },
  };
}

test("policy execution preserves emitted digits without arithmetic correction", () => {
  const model = policy(["0", "0", "9", "end"]);

  assert.deepEqual(runPolicy(model, "347+58"), {
    answer: "009",
    keys: ["0", "0", "9", "Enter"],
    terminated: true,
  });

  assert.deepEqual(runPolicy(model, "1000/25"), runPolicy(model, "347+58"));
});

test("policy execution rejects malformed, empty, and unterminated output", () => {
  for (const keys of [
    ["end"],
    ["-", "end"],
    ["1", "-", "end"],
    ["x"],
    ["1", "2"],
  ]) {
    assert.throws(() => runPolicy(policy(keys), "2+3"));
  }

  assert.throws(() => runPolicy(policy(["1", "end"]), "2**3"));
  assert.throws(() => runPolicy(policy(["1", "end"], Infinity), "2+3"));
});

test("digit positions share a function across operands and support thousands", async () => {
  const { encodeExpression, digitPosition } =
    await import("../server/brain/expression.ts");
  const tokens = encodeExpression("1000+25");

  assert.deepEqual(
    tokens.map((t) => t.symbol),
    [..."1000+25"],
  );

  assert.deepEqual(tokens[0].position, digitPosition(0, 3));
  assert.deepEqual(tokens[3].position?.slice(2), tokens[6].position?.slice(2));
  assert.notDeepEqual(tokens[3].position, tokens[6].position);
  assert.equal(tokens[4].position, undefined);
  assert.equal(digitPosition(1, 1000).length, 6);
  assert.throws(() => digitPosition(0, -1));
});

test("operand signs retain digit positions and remain distinct from the operator", async () => {
  const { encodeExpression, digitPosition } =
    await import("../server/brain/expression.ts");

  for (const expression of ["-12+3", "12*-3", "-12--3", "-1000/-25"]) {
    const tokens = encodeExpression(expression);

    assert.deepEqual(
      tokens.map((token) => token.symbol),
      [...expression],
    );

    assert.equal(
      tokens.filter((token) => token.position === undefined).length,
      1,
    );

    const operator = tokens.findIndex((token) => token.position === undefined);
    assert.deepEqual(tokens[operator - 1].position, digitPosition(0, 0));
    assert.deepEqual(tokens.at(-1)?.position, digitPosition(1, 0));
    assert.equal(runPolicy(policy(["9", "end"]), expression).answer, "9");
  }
});
