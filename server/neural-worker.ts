import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  ActivityTiming,
  NeuralActivity,
  Operation,
  Prediction,
} from "../shared/contracts.ts";

export type ActivityPacket = {
  kind: "activity";
  timing?: ActivityTiming;
  id: number;
  neural: NeuralActivity;
  ready?: false;
};

export type ReadyPacket = { ready: true; neurons: number; connections: number };

export type ResultPacket = Prediction & {
  id: number;
  kind?: never;
  error?: never;
  ready?: false;
};

type ErrorPacket = { id: number; error: string; kind?: never; ready?: false };

type PendingRequest = {
  onActivity?: (packet: ActivityPacket) => void;
  progress: () => void;
  resolve: (packet: ResultPacket) => void;
  reject: (error: Error) => void;
};

export class NeuralWorker {
  private closing?: Promise<void>;
  declare checkpoint: string | null;
  declare checksum: string | null;
  declare pending: Map<number, PendingRequest>;
  declare sequence: number;
  declare ready: Promise<ReadyPacket> | null | undefined;
  declare process: ChildProcessWithoutNullStreams | undefined;

  constructor(
    checkpoint: string | null = null,
    checksum: string | null = null,
  ) {
    this.checkpoint = checkpoint;
    this.checksum = checksum;
    this.pending = new Map();
    this.sequence = 0;
  }

  start(): Promise<ReadyPacket> {
    if (this.closing) {
      return this.closing.then(() => this.start());
    }

    if (this.ready) {
      return this.ready;
    }

    this.ready = new Promise<ReadyPacket>((resolve, reject) => {
      this.process = spawn(
        process.execPath,
        ["--max-old-space-size=1024", "server/brain/worker.ts"],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            NODE_ENV: process.env.NODE_ENV ?? "production",
            ...(this.checkpoint ? { ZETAFLY_CHECKPOINT: this.checkpoint } : {}),
            ...(this.checksum
              ? { ZETAFLY_CHECKPOINT_SHA256: this.checksum }
              : {}),
          },
        },
      );

      const timer = setTimeout(() => {
        this.close();
        reject(new Error("Neural worker startup timed out"));
      }, 90000);

      this.process.stderr.on("data", (chunk) => process.stderr.write(chunk));

      createInterface({ input: this.process.stdout }).on("line", (line) => {
        let packet: ReadyPacket | ActivityPacket | ResultPacket | ErrorPacket;

        try {
          packet = JSON.parse(line) as
            ReadyPacket | ActivityPacket | ResultPacket | ErrorPacket;
        } catch {
          return;
        }

        if (packet.ready) {
          clearTimeout(timer);
          resolve(packet);

          return;
        }

        const request = this.pending.get(packet.id);

        if (request && packet.kind === "activity") {
          request.progress();
          request.onActivity?.(packet);

          return;
        }

        if (request && packet.kind !== "activity") {
          this.pending.delete(packet.id);

          packet.error
            ? request.reject(new Error(packet.error))
            : request.resolve(packet as ResultPacket);
        }
      });

      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);

        for (const item of this.pending.values()) {
          item.reject(error);
        }

        this.pending.clear();
        this.ready = null;
      };

      this.process.on("error", fail);

      this.process.on("exit", (code) =>
        fail(new Error(`Neural worker exited (${code})`)),
      );
    });

    return this.ready;
  }

  async predict(
    a: number,
    b: number,
    seed: number,
    operation: Operation = "+",
    onActivity?: (packet: ActivityPacket) => void,
    rejected: readonly string[] = [],
  ): Promise<ResultPacket> {
    await this.start();
    const id = ++this.sequence;

    return new Promise<ResultPacket>((resolve, reject) => {
      const expire = (message: string) => {
        this.pending.get(id)?.reject(new Error(message));
        this.pending.delete(id);
        void this.close();
      };
      const deadline = setTimeout(
        () => expire("Inference exceeded its execution budget"),
        120000,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const progress = () => {
        clearTimeout(timer);

        timer = setTimeout(() => {
          expire("Inference stopped making progress");
        }, 30000);
      };

      progress();

      this.pending.set(id, {
        onActivity,
        progress,
        resolve: (value) => {
          clearTimeout(timer);
          clearTimeout(deadline);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          clearTimeout(deadline);
          reject(error);
        },
      });

      this.process!.stdin.write(
        `${JSON.stringify({ id, a, b, seed, operation, rejected })}\n`,
      );
    });
  }

  async close() {
    if (this.closing) {
      return this.closing;
    }

    const child = this.process;
    this.ready = null;

    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    this.closing = new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      child.kill("SIGTERM");
    }).finally(() => {
      this.closing = undefined;
    });

    return this.closing;
  }
}
