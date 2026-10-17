import { readFile, writeFile } from "node:fs/promises";
import { sha256 } from "../server/brain/graph.ts";

const manifestPath = "web/public/brain/manifest.json";
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  source: string;
  sourceSha256: string;
  sha256: string;
};
const path = "research/data/annotations-630.tsv";
let bytes: Uint8Array;

try {
  bytes = await readFile(path);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }

  const response = await fetch(manifest.source, {
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    throw Error("Annotation download failed");
  }

  bytes = new Uint8Array(await response.arrayBuffer());
}

if (sha256(bytes) !== manifest.sourceSha256) {
  throw Error("Annotation source hash mismatch");
}

const lines = new TextDecoder().decode(bytes).trimEnd().split(/\r?\n/);
const header = lines.shift()!.split("\t");
const columns = ["root_id", "pos_x", "pos_y", "pos_z"].map((key) =>
  header.indexOf(key),
);

if (columns.some((index) => index < 0)) {
  throw Error("Missing annotation columns");
}

const anchors = new Map<string, number[]>();

for (const line of lines) {
  const fields = line.split("\t");
  const id = fields[columns[0]];

  if (!anchors.has(id)) {
    anchors.set(
      id,
      columns
        .slice(1)
        .map((column, axis) =>
          fields[column]?.trim()
            ? Number(fields[column]) * [4, 4, 40][axis]
            : NaN,
        ),
    );
  }
}

const ids = (await readFile("research/data/neurons.csv", "utf8"))
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.split(",")[0]);
const points: number[][] = [];

ids.forEach((id, index) => {
  const xyz = anchors.get(id);

  if (xyz?.every(Number.isFinite)) {
    points.push([index, ...xyz]);
  }
});

const quantile = (sorted: number[], q: number) => {
  const position = (sorted.length - 1) * q;
  const index = Math.floor(position);
  const fraction = position - index;
  const a = sorted[index];
  const b = sorted[Math.ceil(position)];

  return fraction < 0.5 ? a + (b - a) * fraction : b - (b - a) * (1 - fraction);
};
const bounds = [1, 2, 3].map((axis) => {
  const sorted = points.map((point) => point[axis]).sort((a, b) => a - b);

  return [quantile(sorted, 0.005), quantile(sorted, 0.995)];
});
const center = bounds.map(([low, high]) => (high + low) / 2);
const scale = 7.5 / Math.max(...bounds.map(([low, high]) => high - low));
const packed = Buffer.alloc(points.length * 16);

points.forEach(([index, x, y, z], row) => {
  [
    index,
    (x - center[0]) * scale,
    -((z - center[2]) * scale),
    -((y - center[1]) * scale),
  ].forEach((value, column) => {
    packed.writeFloatLE(value, row * 16 + column * 4);
  });
});

if (process.argv.includes("--check")) {
  if (sha256(packed) !== manifest.sha256) {
    throw Error("Generated anchors differ from the published asset");
  }

  console.log(`Verified ${points.length} anatomy anchors`);
} else {
  await writeFile("web/public/brain/anchors.bin", packed);

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        mapped: points.length,
        unmapped: ids.length - points.length,
        population: ids.length,
        sha256: sha256(packed),
      },
      null,
      2,
    )}\n`,
  );

  console.log(`Prepared ${points.length} anatomy anchors`);
}
