import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { loadGraph, prepareGraph, sha256 } from "../server/brain/graph.ts";

const report = JSON.parse(await readFile("models/connectome.json", "utf8")) as {
  sha256: Record<string, string>;
  upstreamRevision: string;
};

await mkdir("research/data", { recursive: true });

for (const [local, remote] of Object.entries({
  "neurons.csv": "2023_03_23_completeness_630_final.csv",
  "connectivity.parquet": "2023_03_23_connectivity_630_final.parquet",
})) {
  const path = `research/data/${local}`;
  const expected = report.sha256[path];

  try {
    if (sha256(await readFile(path)) === expected) {
      console.log(`Verified ${local}`);
      continue;
    }
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }

  const temporary = `${path}.download`;

  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/philshiu/Drosophila_brain_model/${report.upstreamRevision}/${remote}`,
      { signal: AbortSignal.timeout(120000) },
    );

    if (!response.ok) {
      throw Error(`Model download failed: ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    if (sha256(bytes) !== expected) {
      throw Error(`Model hash mismatch: ${local}`);
    }

    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }

  console.log(`Verified ${local}`);
}

try {
  await loadGraph();
  console.log("Verified Node graph");
} catch {
  await prepareGraph();
  console.log("Prepared complete Node graph");
}
