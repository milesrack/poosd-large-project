import assert from "node:assert/strict";
import test from "node:test";
import type { NumericArray } from "../server/brain/arrays.ts";
import {
  decodeArchive,
  decodeArray,
  encodeArray,
} from "../server/brain/arrays.ts";

function numeric(data: string | NumericArray): NumericArray {
  if (typeof data === "string") {
    throw Error("Expected numeric fixture");
  }

  return data;
}

test("numeric NPY round trips without evaluating headers or object data", () => {
  for (const dtype of [
    "<f4",
    "<f8",
    "<i1",
    "<u1",
    "<i2",
    "<u2",
    "<i4",
    "<u4",
  ]) {
    assert.deepEqual(
      Array.from(numeric(decodeArray(encodeArray([1, 2, 3], [3], dtype)).data)),
      [1, 2, 3],
    );
  }

  assert.equal(decodeArray(encodeArray("digits", [], "<U6")).data, "digits");
  const fortran = encodeArray([1, 3, 2, 4], [2, 2], "<f8");
  const header = new TextDecoder().decode(fortran.subarray(10, 128));

  fortran.set(
    new TextEncoder().encode(
      header.replace("'fortran_order': False", "'fortran_order': True "),
    ),
    10,
  );

  assert.deepEqual(
    Array.from(numeric(decodeArray(fortran).data)),
    [1, 2, 3, 4],
  );

  const invalid = encodeArray([1, 2], [2], "<f8");
  invalid[0] = 0;
  assert.throws(() => decodeArray(invalid));
  assert.throws(() => decodeArchive(new Uint8Array([1, 2, 3])));
});
