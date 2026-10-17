import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { sha256 } from "./graph.ts";

export function mapAnatomy(text: string, ids: string[]) {
  const lines = text.trimEnd().split(/\r?\n/);
  const header = lines.shift()!.split("\t");
  const columns = ["root_id", "super_class", "cell_class"].map((key) =>
    header.indexOf(key),
  );

  if (columns.some((index) => index < 0)) {
    throw Error("Missing visual annotation columns");
  }

  const lookup = new Map(ids.map((id, index) => [id, index]));
  const learning = {
    kenyon: [] as number[],
    output: [] as number[],
    dopamine: [] as number[],
    projection: [] as number[],
  };
  const subtype = header.indexOf("cell_sub_class");
  const retina: number[] = [];
  const readout: number[] = [];
  const seen = new Set<number>();

  for (const line of lines) {
    const fields = line.split("\t");
    const id = lookup.get(fields[columns[0]]);

    if (id === undefined || seen.has(id)) {
      continue;
    }

    seen.add(id);
    const cell = fields[columns[2]];
    if (cell === "Kenyon_Cell") {
      learning.kenyon.push(id);
    }
    if (cell === "MBON") {
      learning.output.push(id);
    }
    if (cell === "DAN") {
      learning.dopamine.push(id);
    }
    if (cell === "ALPN" && fields[subtype] === "uniglomerular") {
      learning.projection.push(id);
    }

    if (fields[columns[1]] === "sensory" && fields[columns[2]] === "visual") {
      retina.push(id);
    }

    if (["descending", "motor"].includes(fields[columns[1]])) {
      readout.push(id);
    }
  }

  retina.sort((a, b) => a - b);
  readout.sort((a, b) => a - b);

  if (!retina.length || !readout.length) {
    throw Error("Missing visual or output anatomy");
  }

  for (const cells of Object.values(learning)) {
    cells.sort((a, b) => a - b);
  }
  return { sensory: retina, readout, learning };
}

export async function loadAnatomy() {
  const manifest = JSON.parse(
    await readFile("web/public/brain/manifest.json", "utf8"),
  ) as { source: string; sourceSha256: string };
  const path = "research/data/annotations-630.tsv";
  let bytes: Uint8Array;
  let downloaded = false;

  try {
    bytes = await readFile(path);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }

    const response = await fetch(manifest.source, {
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      throw Error("Visual annotation download failed");
    }

    bytes = new Uint8Array(await response.arrayBuffer());
    downloaded = true;
  }

  if (sha256(bytes) !== manifest.sourceSha256) {
    throw Error("Visual annotation hash mismatch");
  }

  if (downloaded) {
    const temporary = `${path}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  const neuronBytes = await readFile("research/data/neurons.csv");
  const provenance = JSON.parse(
    await readFile("models/connectome.json", "utf8"),
  ) as { sha256: Record<string, string> };
  const neuronOrderSha256 = sha256(neuronBytes);

  if (neuronOrderSha256 !== provenance.sha256["research/data/neurons.csv"]) {
    throw Error("Neuron order hash mismatch");
  }

  const ids = new TextDecoder()
    .decode(neuronBytes)
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((row) => row.split(",")[0]);

  return {
    ...mapAnatomy(new TextDecoder().decode(bytes), ids),
    annotationSha256: manifest.sourceSha256,
    source: manifest.source,
    neuronOrderSha256,
  };
}
