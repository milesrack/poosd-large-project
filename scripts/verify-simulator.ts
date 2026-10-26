import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Brain } from "../research/simulator.ts";
import { decodeArchive } from "../server/brain/arrays.ts";

const source = "tests/fixtures/brain-reference.npz";
const bytes = await readFile(source);
const reference = decodeArchive(bytes);
const brain = await Brain.create();

if (
  typeof reference.pairs.data === "string" ||
  typeof reference.features.data === "string"
) {
  throw Error("Use numeric recordings");
}

let identical = 0;
let differentCounts = 0;
let maximumDifference = 0;

for (let pair = 0; pair < 100; pair++) {
  const a = reference.pairs.data[pair * 2];
  const b = reference.pairs.data[pair * 2 + 1];
  const { counts } = brain.observe(a, b);
  let different = 0;

  for (let i = 0; i < counts.length; i++) {
    const delta = Math.abs(
      counts[i] - reference.features.data[pair * counts.length + i],
    );

    if (delta) {
      different++;
    }

    maximumDifference = Math.max(maximumDifference, delta);
  }

  if (!different) {
    identical++;
  }

  differentCounts += different;
}

assert.equal(
  brain.observe(0, 0, { quiet: true }).counts.reduce((a, b) => a + b, 0),
  0,
);

assert.equal(
  identical,
  100,
  `${differentCounts} differing counts; largest difference: ${maximumDifference}`,
);
console.log("Simulator parity passed: 100 reference recordings");
