import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadGraph } from "../server/brain/graph.ts";
import { decodePolicy } from "../server/brain/policy.ts";
import { restoreWeights } from "../server/brain/weights.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    expression: { type: "string" },
  },
});

if (!values.model?.endsWith(".npz") || !values.expression) {
  throw Error("Use --model weights.npz --expression '17*6'");
}

const brain = restoreWeights(await loadGraph(), await readFile(values.model));

console.log(JSON.stringify(decodePolicy(brain, values.expression)));
