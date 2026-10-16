import assert from "node:assert/strict";
import test from "node:test";
import { parseProblem } from "../server/browser.ts";
import { DEFAULTS, parseSettings } from "../server/settings.ts";

test("all native Zetamac operation ranges and durations are supported", () => {
  assert.deepEqual(parseSettings(), DEFAULTS);

  for (const duration of [30, 60, 120, 300, 600]) {
    assert.equal(parseSettings({ duration }).duration, duration);
  }

  assert.equal(
    parseSettings({ add_left_min: -200, add_right_max: 1000 }).add_left_min,
    -200,
  );
});

test("reject invalid operation combinations, unsafe ranges and unsupported durations", () => {
  for (const settings of [
    { add: false, sub: false, mul: false, div: false },
    { add_left_min: 200 },
    { mul_right_max: Number.MAX_SAFE_INTEGER },
    { duration: 1000 },
    { attempts: -1 },
    { feedback: 1 },
    { constructor: 2 },
    null,
    [],
  ]) {
    assert.throws(() => parseSettings(settings));
  }
});

test("parse all four displayed operators and signed multi-digit operands", () => {
  for (const [text, a, b, operation] of [
    ["123 + 456", 123, 456, "+"],
    ["24 − 7", 24, 7, "-"],
    ["-12 × 8", -12, 8, "*"],
    ["120 ÷ 12", 120, 12, "/"],
    ["-4 - -2", -4, -2, "-"],
  ] as const) {
    assert.deepEqual(parseProblem(text), { a, b, operation, text });
  }

  for (const text of ["garbage", "3 ^ 2", "1 / 0"]) {
    assert.throws(() => parseProblem(text));
  }
});

test("division requires a non-zero left factor but accepts a zero right factor", () => {
  assert.throws(
    () => parseSettings({ mul_left_min: 0, mul_left_max: 0 }),
    /non-zero/,
  );
  assert.equal(parseSettings({ mul_right_min: 0, mul_right_max: 0 }).div, true);
});
