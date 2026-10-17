import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256 } from "../server/brain/graph.ts";

test("brain anatomy has exact unique model-index anchors and a verified source manifest", async () => {
  const manifest = JSON.parse(
    await readFile("web/public/brain/manifest.json", "utf8"),
  ) as { sha256: string; mapped: number; unmapped: number };
  const buffer = await readFile("web/public/brain/anchors.bin");

  assert.equal(
    createHash("sha256").update(buffer).digest("hex"),
    manifest.sha256,
  );

  const data = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const ids = new Set();
  assert.equal(buffer.length / 16, manifest.mapped);
  assert.equal(manifest.mapped + manifest.unmapped, 127400);

  for (let i = 0; i < buffer.length; i += 16) {
    const index = data.getFloat32(i, true);
    assert.ok(Number.isInteger(index) && index >= 0 && index < 127400);
    assert.ok(!ids.has(index));
    ids.add(index);

    for (let axis = 4; axis < 16; axis += 4) {
      assert.ok(Number.isFinite(data.getFloat32(i + axis, true)));
    }
  }
});

test("anatomy framing keeps the central population in view despite coordinate outliers", async () => {
  const buffer = await readFile("web/public/brain/anchors.bin");
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const y = [];

  for (let i = 8; i < buffer.length; i += 16) {
    y.push(view.getFloat32(i, true));
  }

  y.sort((a, b) => a - b);

  assert.ok(
    Math.abs(y[Math.floor(y.length / 2)]) < 1.5,
    "Outliers pushed the brain away from the camera target",
  );
});

test("visual annotations align by root ID and ignore taste neurons and duplicate rows", async () => {
  const { mapAnatomy } = await import("../server/brain/anatomy.ts");
  const rows =
    "root_id\tsuper_class\tcell_class\na\tsensory\tvisual\nb\tsensory\tgustatory\nc\tdescending\tDN\na\tsensory\tvisual\nd\tmotor\tmotor\nx\tsensory\tvisual";
  const layout = mapAnatomy(rows, ["d", "c", "b", "a"]);
  assert.deepEqual(layout.sensory, [3]);
  assert.deepEqual(layout.readout, [0, 1]);
});

test("verified visual annotations load from a read-only cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zetafly-retina-"));
  const annotations =
    "root_id\tsuper_class\tcell_class\na\tsensory\tvisual\nb\tmotor\tmotor\n";
  const neurons = "root_id\na\nb\n";
  const files = {
    "web/public/brain/manifest.json": JSON.stringify({
      sourceSha256: sha256(Buffer.from(annotations)),
    }),
    "models/connectome.json": JSON.stringify({
      sha256: { "research/data/neurons.csv": sha256(Buffer.from(neurons)) },
    }),
    "research/data/neurons.csv": neurons,
    "research/data/annotations-630.tsv": annotations,
  };

  try {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(join(directory, path, ".."), { recursive: true });
      await writeFile(join(directory, path), contents);
    }

    await chmod(join(directory, "research/data/annotations-630.tsv"), 0o444);
    const module = new URL("../server/brain/anatomy.ts", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {loadAnatomy} from ${JSON.stringify(module)}; const anatomy = await loadAnatomy(); console.log(JSON.stringify([anatomy.sensory, anatomy.readout]));`,
      ],
      { cwd: directory, encoding: "utf8" },
    );

    assert.deepEqual(JSON.parse(output), [[0], [1]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("learning anatomy uses curated cell classes rather than transmitter predictions", async () => {
  const { mapAnatomy } = await import("../server/brain/anatomy.ts");
  const text =
    "root_id\tsuper_class\tcell_class\tcell_sub_class\ttop_nt\na\tsensory\tvisual\t\tacetylcholine\nb\tmotor\tmotor\t\tacetylcholine\nc\tcentral\tKenyon_Cell\t\tdopamine\nd\tcentral\tMBON\t\tglutamate\ne\tcentral\tDAN\t\tdopamine\nf\tcentral\tALPN\tuniglomerular\tacetylcholine";
  const mapped = mapAnatomy(text, ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(mapped.learning, {
    kenyon: [2],
    output: [3],
    dopamine: [4],
    projection: [5],
  });
});
