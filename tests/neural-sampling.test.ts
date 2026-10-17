import assert from "node:assert/strict";
import test from "node:test";
import { sampleNeurons } from "../shared/neural.ts";

test("strong sensory activity cannot hide weaker downstream activity at either display limit", () => {
  const inputs = Array.from({ length: 256 }, (_, id) => id);
  const ids = Array.from({ length: 512 }, (_, id) => id);
  const value = (id: number) => (id < 256 ? 1 : -0.1);
  const packet = sampleNeurons(ids, value, inputs, 192);
  const visible = sampleNeurons(packet, value, inputs, 48);

  assert.equal(packet.length, 192);
  assert.equal(visible.length, 48);
  assert.equal(packet.filter((id) => id >= 256).length, 96);
  assert.equal(visible.filter((id) => id >= 256).length, 24);
  assert.deepEqual(visible.slice(24), ids.slice(256, 280));
});

test("unused sampling capacity is filled from available neurons without duplicates", () => {
  assert.deepEqual(
    sampleNeurons([0, 1, 2], (id) => -id, [0], 8),
    [2, 1, 0],
  );
  assert.deepEqual(
    sampleNeurons([0, 1, 2], (id) => id, [], 2),
    [2, 1],
  );
  assert.deepEqual(
    sampleNeurons([], () => 0, [], 48),
    [],
  );
});
