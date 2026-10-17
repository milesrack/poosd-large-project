import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  asyncBufferFromFile,
  parquetMetadataAsync,
  parquetRead,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";

export interface BrainGraph {
  inputs: number[];
  offsets: Uint32Array;
  edges: Uint32Array;
  post: Uint32Array;
  weights: Float64Array;
}

interface GraphManifest {
  revision: string;
  neurons: number;
  connections: number;
  hashes: Record<string, string>;
}

export const POPULATION = 127400,
  CONNECTIONS = 14687178,
  REVISION = "91bdd1e7dcf193f3e7ca5a8933497fcef63b7960";
export const SUGAR_IDS = [
  "720575940624963786",
  "720575940630233916",
  "720575940637568838",
  "720575940638202345",
  "720575940617000768",
  "720575940630797113",
  "720575940632889389",
  "720575940621754367",
  "720575940621502051",
  "720575940640649691",
  "720575940639332736",
  "720575940616885538",
  "720575940639198653",
  "720575940620900446",
  "720575940617937543",
  "720575940632425919",
  "720575940633143833",
  "720575940612670570",
  "720575940628853239",
  "720575940629176663",
];
export const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export async function inputs(directory = "research/data"): Promise<number[]> {
  const rows = (await readFile(`${directory}/neurons.csv`, "utf8"))
    .trim()
    .split(/\r?\n/)
    .slice(1);

  if (rows.length !== POPULATION) {
    throw Error("Unexpected brain population");
  }

  const lookup = new Map(
    rows.map((line, index) => [line.split(",")[0], index]),
  );
  const sites = SUGAR_IDS.map((id) => lookup.get(id));

  if (sites.some((value) => value === undefined)) {
    throw Error("Missing sensory neurons");
  }

  return sites as number[];
}

export async function prepareGraph(
  directory = "research/data",
): Promise<BrainGraph> {
  const file = await asyncBufferFromFile(`${directory}/connectivity.parquet`);
  const metadata = await parquetMetadataAsync(file);

  if (Number(metadata.num_rows) !== CONNECTIONS) {
    throw Error("Unexpected connection count");
  }

  const pre = new Uint32Array(CONNECTIONS);
  const post = new Uint32Array(CONNECTIONS);
  const weights = new Float64Array(CONNECTIONS);
  const columns: Record<string, Uint32Array | Float64Array> = {
    Presynaptic_Index: pre,
    Postsynaptic_Index: post,
    "Excitatory x Connectivity": weights,
  };

  await parquetRead({
    file,
    metadata,
    compressors,
    columns: Object.keys(columns),
    onChunk: ({ columnName, columnData, rowStart }) => {
      const target = columns[columnName];

      for (let i = 0; i < columnData.length; i++) {
        const value = Number(columnData[i]);

        if (
          !Number.isFinite(value) ||
          (target !== weights &&
            (!Number.isInteger(value) || value < 0 || value >= POPULATION))
        ) {
          throw Error("Invalid graph edge");
        }

        target[rowStart + i] =
          target === weights ? value * (0.275 * 0.001) : value;
      }
    },
  });

  const offsets = new Uint32Array(POPULATION + 1);
  const edges = new Uint32Array(CONNECTIONS);

  for (const source of pre) {
    offsets[source + 1]++;
  }

  for (let i = 1; i < offsets.length; i++) {
    offsets[i] += offsets[i - 1];
  }

  const cursor = offsets.slice();

  for (let edge = 0; edge < CONNECTIONS; edge++) {
    edges[cursor[pre[edge]]++] = edge;
  }

  const arrays = { offsets, edges, post, weights };
  const hashes: Record<string, string> = {};

  for (const [name, array] of Object.entries(arrays)) {
    const bytes = Buffer.from(array.buffer);
    await writeFile(`${directory}/${name}.bin`, bytes);
    hashes[name] = sha256(bytes);
  }

  await writeFile(
    `${directory}/graph.json`,
    `${JSON.stringify(
      {
        revision: REVISION,
        neurons: POPULATION,
        connections: CONNECTIONS,
        hashes,
      },
      null,
      2,
    )}\n`,
  );

  return { offsets, edges, post, weights, inputs: await inputs(directory) };
}

export async function loadGraph(
  directory = "research/data",
): Promise<BrainGraph> {
  const manifest = JSON.parse(
    await readFile(`${directory}/graph.json`, "utf8"),
  ) as GraphManifest;

  if (
    manifest.revision !== REVISION ||
    manifest.neurons !== POPULATION ||
    manifest.connections !== CONNECTIONS
  ) {
    throw Error("Unexpected graph revision");
  }

  const graph: Partial<BrainGraph> = { inputs: await inputs(directory) };

  for (const [name, Type, length] of [
    ["offsets", Uint32Array, POPULATION + 1],
    ["edges", Uint32Array, CONNECTIONS],
    ["post", Uint32Array, CONNECTIONS],
    ["weights", Float64Array, CONNECTIONS],
  ] as const) {
    const bytes = await readFile(`${directory}/${name}.bin`);

    if (
      bytes.length !== length * Type.BYTES_PER_ELEMENT ||
      sha256(bytes) !== manifest.hashes[name]
    ) {
      throw Error(`Graph hash mismatch: ${name}`);
    }

    const aligned = bytes.byteOffset % Type.BYTES_PER_ELEMENT === 0;
    const buffer = aligned
      ? bytes.buffer
      : bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
    const offset = aligned ? bytes.byteOffset : 0;

    if (name === "weights") {
      graph.weights = new Float64Array(buffer, offset, length);
    } else {
      graph[name] = new Uint32Array(buffer, offset, length);
    }
  }

  return graph as BrainGraph;
}
