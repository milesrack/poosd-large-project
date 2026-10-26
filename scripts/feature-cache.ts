import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  truncateSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { deserialize, serialize } from "node:v8";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import type {
  KeyExample,
  SequenceBrain,
  SequenceExample,
} from "../server/brain/sequence.ts";

export async function cacheSequenceFeatures(
  model: SequenceBrain,
  examples: SequenceExample[],
  concurrency = 1,
  onProgress?: (completed: number) => void,
  cachePath?: string,
): Promise<KeyExample[][]> {
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > availableParallelism()
  ) {
    throw Error("Feature workers must fit the available CPU count");
  }
  const result: KeyExample[][] = new Array(examples.length);
  let file: number | undefined;
  const pool: Worker[] = [];
  const pack = (value: object) => {
    const payload = serialize(value);
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32LE(payload.length);
    payload.copy(frame, 4);
    return frame;
  };
  try {
    if (cachePath) {
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            options: { ...model.options, hidden: undefined },
            graph: model.graphSha256,
            examples,
            v8: process.versions.v8,
          }),
        )
        .update(
          new Uint8Array(
            model.parameters.buffer,
            model.parameters.byteOffset,
            model.headStart * 8,
          ),
        );
      for (const path of [
        "../server/brain/sequence.ts",
        "../server/brain/expression.ts",
        "../server/brain/random.ts",
      ]) {
        fingerprint.update(readFileSync(new URL(path, import.meta.url)));
      }
      const key = fingerprint.digest("hex");
      const bytes = existsSync(cachePath)
        ? readFileSync(cachePath)
        : Buffer.alloc(0);
      let position = 0;
      let verified = false;
      while (position + 4 <= bytes.length) {
        const length = bytes.readUInt32LE(position);
        if (position + 4 + length > bytes.length) {
          break;
        }
        const record = deserialize(
          bytes.subarray(position + 4, position + 4 + length),
        ) as { fingerprint?: string; index: number; features: KeyExample[] };
        if (!verified) {
          if (record.fingerprint !== key) {
            throw Error(
              "Feature cache belongs to a different model or dataset",
            );
          }
          verified = true;
        } else {
          if (
            !Number.isInteger(record.index) ||
            record.index < 0 ||
            record.index >= examples.length ||
            !Array.isArray(record.features) ||
            record.features.length !==
              examples[record.index].answer.length + 1 ||
            record.features.some(
              (row) =>
                !(row.features instanceof Float64Array) ||
                row.features.length !== model.options.readout.length,
            )
          ) {
            throw Error("Invalid feature cache record");
          }
          result[record.index] = record.features;
        }
        position += 4 + length;
      }
      if (bytes.length && !verified) {
        throw Error("Incomplete feature cache header");
      }
      if (position !== bytes.length) {
        truncateSync(cachePath, position);
      }
      file = openSync(cachePath, "a");
      if (!verified) {
        appendFileSync(file, pack({ fingerprint: key }));
      }
    }
    const pending = examples.flatMap((example, index) =>
      result[index] ? [] : [{ example, index }],
    );
    let completed = examples.length - pending.length;
    onProgress?.(completed);
    const save = (index: number, features: KeyExample[]) => {
      if (file !== undefined) {
        appendFileSync(file, pack({ index, features }));
      }
      result[index] = features;
      onProgress?.(++completed);
    };
    const count = Math.min(concurrency, pending.length);
    const checkpoint = model.checkpoint();
    if (concurrency === 1 || pending.length < 2) {
      for (const { example, index } of pending) {
        save(index, model.features(example.expression, example.answer));
      }
      return result;
    }
    await Promise.all(
      Array.from(
        { length: count },
        (_, slot) =>
          new Promise<void>((resolve, reject) => {
            const jobs = pending.filter((_, index) => index % count === slot);
            const worker = new Worker(new URL(import.meta.url), {
              workerData: { kind: "sequence-features", checkpoint, jobs },
            });
            pool.push(worker);
            worker.on(
              "message",
              ({
                index,
                features,
              }: {
                index: number;
                features: KeyExample[];
              }) => {
                try {
                  save(index, features);
                } catch (error) {
                  reject(error);
                }
              },
            );
            worker.once("error", reject);
            worker.once("exit", (code) =>
              code === 0
                ? resolve()
                : reject(Error(`Feature worker exited (${code})`)),
            );
          }),
      ),
    );
    if (completed !== examples.length) {
      throw Error("Feature cache is incomplete");
    }
    return result;
  } finally {
    await Promise.all(pool.map((worker) => worker.terminate()));
    if (file !== undefined) {
      closeSync(file);
    }
  }
}

if (!isMainThread && workerData?.kind === "sequence-features") {
  const { loadGraph } = await import("../server/brain/graph.ts");
  const { SequenceBrain } = await import("../server/brain/sequence.ts");
  const { checkpoint, jobs } = workerData as {
    checkpoint: Uint8Array;
    jobs: { index: number; example: SequenceExample }[];
  };
  const model = SequenceBrain.restore(await loadGraph(), checkpoint, {
    inference: true,
  });
  for (const { index, example } of jobs) {
    const features = model.features(example.expression, example.answer);
    parentPort!.postMessage(
      { index, features },
      features.map((row) => row.features.buffer as ArrayBuffer),
    );
  }
  parentPort!.close();
}
