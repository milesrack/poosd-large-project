import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { NeuralWorker } from "../server/neural-worker.ts";

test("restarting waits for the previous worker to finish closing", async (context) => {
  const worker = new NeuralWorker();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const previous = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr] as [PassThrough, PassThrough, PassThrough],
  });

  context.mock.method(previous, "kill", () => {
    setImmediate(() => previous.emit("exit", 0));

    return true;
  });

  worker.process = previous;
  const closing = worker.close();
  const restarted = worker.start();
  const duringClose = worker.process;

  try {
    await closing;
    await restarted;
    assert.equal(duringClose, previous);
    assert.notEqual(worker.process, previous);
    assert.ok(worker.ready);
  } finally {
    await worker.close();
  }
});

for (const progressing of [false, true]) {
  test(
    progressing
      ? "activity cannot extend inference beyond its absolute deadline"
      : "stalled inference closes its worker and clears the pending request",
    async (context) => {
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const worker = new NeuralWorker();

      context.mock.method(worker, "start", async () => ({
        ready: true,
        neurons: 1,
        connections: 1,
      }));

      const close = context.mock.method(worker, "close", async () => {});
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();

      worker.process = Object.assign(new ChildProcess(), {
        stdin,
        stdout,
        stderr,
        stdio: [stdin, stdout, stderr] as [
          PassThrough,
          PassThrough,
          PassThrough,
        ],
      });

      const result = worker.predict(2, 3, 7);
      await Promise.resolve();

      const rejected = assert.rejects(
        result,
        progressing ? /execution budget/ : /making progress/,
      );

      if (progressing) {
        for (let i = 0; i < 5; i++) {
          context.mock.timers.tick(20000);
          worker.pending.get(1)!.progress();
        }
      }

      context.mock.timers.tick(progressing ? 20000 : 30000);
      await rejected;
      assert.equal(worker.pending.size, 0);
      assert.equal(close.mock.callCount(), 1);
      context.mock.timers.tick(120000);
      assert.equal(close.mock.callCount(), 1);
    },
  );
}
