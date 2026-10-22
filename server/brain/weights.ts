import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Archive, NumericDecodedArray } from "./arrays.ts";
import { decodeArchive } from "./arrays.ts";
import type { BrainGraph } from "./graph.ts";
import { loadGraph, sha256 } from "./graph.ts";
import { SequenceBrain } from "./sequence.ts";

export const DEFAULT_WEIGHTS = "models/default/weights.npz";
const required = [
  "format_version",
  "config",
  "sensory",
  "readout",
  "anatomy_sha256",
  "graph_sha256",
  "ages",
  "parameters",
  "mean",
  "scale",
];

function validateArrays(archive: Archive) {
  const allowed = new Set([...required, "first", "second"]);

  if (
    required.some((key) => !Object.hasOwn(archive, key)) ||
    Object.keys(archive).some((key) => !allowed.has(key)) ||
    !!archive.first !== !!archive.second
  ) {
    throw Error("Unsupported weights: expected sequence NPZ arrays");
  }

  function array(name: string, dtype: string, shape?: number[]) {
    const row = archive[name];

    if (
      !row ||
      row.dtype === "U" ||
      `${row.dtype}${row.width}` !== dtype ||
      (shape &&
        (row.shape.length !== shape.length ||
          row.shape.some((size, i) => size !== shape[i]))) ||
      row.data.some((value) => !Number.isFinite(value))
    ) {
      throw Error(`Invalid weights array: ${name}`);
    }

    return row as NumericDecodedArray;
  }

  const version = array("format_version", "f8", []).data[0];

  if (version !== 8 && version !== 9 && version !== 10) {
    throw Error("Unsupported sequence weights version");
  }

  const config = array("config", "f8", [version === 10 ? 6 : 5]).data;

  if (
    version === 10 &&
    (!Number.isInteger(config[5]) || config[5] < 1 || config[5] > 256)
  ) {
    throw Error("Invalid hidden readout width");
  }

  if (!Number.isInteger(config[0]) || config[0] < 0 || config[0] > 0xffffffff) {
    throw Error("Invalid weights seed");
  }

  for (const name of ["sensory", "readout"]) {
    const row = array(name, "u4");

    if (row.shape.length !== 1 || !row.data.length) {
      throw Error(`Invalid weights array: ${name}`);
    }
  }

  for (const name of ["anatomy_sha256", "graph_sha256"]) {
    array(name, "u1", [32]);
  }

  array("ages", "f8", [2]);

  for (const name of [
    "parameters",
    "mean",
    "scale",
    ...(archive.first ? ["first", "second"] : []),
  ]) {
    const row = array(name, "f8");

    if (row.shape.length !== 1) {
      throw Error(`Invalid weights array: ${name}`);
    }
  }

  if (
    archive.second &&
    (archive.second as NumericDecodedArray).data.some((value) => value < 0)
  ) {
    throw Error("Invalid optimiser variance");
  }
}

export function restoreWeights(graph: BrainGraph, bytes: Uint8Array) {
  const archive = decodeArchive(bytes);
  validateArrays(archive);
  const brain = SequenceBrain.restore(graph, bytes, { inference: true });

  for (const key of ["first", "second"]) {
    if (archive[key] && archive[key].data.length !== brain.parameters.length) {
      throw Error("Invalid optimiser dimensions");
    }
  }

  return brain;
}

export function weightsMetadata(bytes: Uint8Array) {
  const archive = decodeArchive(bytes);
  validateArrays(archive);

  return {
    sha256: sha256(bytes),
    features: archive.readout.data.length,
    synaptic: true,
    arithmeticMode: "sequence" as const,
  };
}

export async function inspectWeights(bytes: Uint8Array) {
  // Reject malformed arrays before allocating the connectome.
  validateArrays(decodeArchive(bytes));
  const brain = restoreWeights(await loadGraph(), bytes);

  return {
    sha256: sha256(bytes),
    features: brain.options.readout.length,
    synaptic: true,
    arithmeticMode: "sequence" as const,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (!process.argv[2]?.endsWith(".npz")) {
      throw Error("Provide a sequence weights .npz path");
    }

    console.log(
      JSON.stringify(await inspectWeights(await readFile(process.argv[2]))),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
