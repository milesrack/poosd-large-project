import type { Page } from "playwright";
import type { InputEvent, MotorFrame, Position } from "../shared/contracts.ts";

export type MotorPage = Pick<Page, "keyboard" | "evaluate">;

export type MotorPublisher = (
  event: MotorFrame | InputEvent,
) => void | Promise<void>;

import { KEYS, restingHands } from "../shared/keyboard.ts";

export { KEYS };

export function contact([x, y, z]: Position) {
  return (
    KEYS.find(
      (k) =>
        Math.abs(x - k.position[0]) <= k.width / 2 &&
        Math.abs(z - k.position[2]) <= 0.043 &&
        Math.abs(y - k.position[1]) <= 0.004,
    )?.code ?? null
  );
}

export function trajectory(start: Position, code: string): Position[] {
  const key = KEYS.find((k) => k.code === code);

  if (!key) {
    throw new Error("Unknown physical key");
  }

  const target = key.position;

  return Array.from({ length: 12 }, (_, i) => {
    const t = (i + 1) / 12;
    const u = t * t * (3 - 2 * t);

    return start.map(
      (v, j) =>
        v + (target[j] - v) * u + (j === 1 ? 0.15 * Math.sin(Math.PI * t) : 0),
    ) as Position;
  });
}

export class Motor {
  declare page: MotorPage;
  declare publish: MotorPublisher;
  declare running: () => boolean;
  declare position: Position;
  declare sequence: number;
  hands = restingHands(0);
  private startedAt: number;
  private hasTyped = false;

  constructor(
    page: MotorPage,
    publish: MotorPublisher,
    running: () => boolean,
    startedAt = Date.now(),
  ) {
    this.startedAt = startedAt;
    this.page = page;
    this.publish = publish;
    this.running = running;
    this.position = [0.18, 1.58, 0.53];
    this.sequence = 0;
  }

  async stroke(code: string) {
    const hand: "left" | "right" =
      /^(Digit[1-5]|Key[QWERTASDFGZXCVB]|ShiftLeft|ControlLeft|AltLeft)$/.test(
        code,
      )
        ? "left"
        : "right";

    if (!this.hasTyped) {
      this.hands = restingHands((Date.now() - this.startedAt) / 1000);
      this.hasTyped = true;
    }

    this.position = this.hands[hand];

    const pose = () => ({
      hand,
      left_effector: this.hands.left,
      right_effector: this.hands.right,
    });

    for (const position of trajectory(this.position, code)) {
      if (!this.running()) {
        throw new Error("Session stopped");
      }

      this.position = position;
      this.hands[hand] = position;

      await this.publish({
        kind: "motor",
        ...pose(),
        phase: "reach",
        effector: position,
        key: code,
      });

      await new Promise((r) => setTimeout(r, 25));
    }

    const resolved = contact(this.position);

    if (resolved !== code) {
      throw new Error("Input withheld: no matching contact");
    }

    const contactId = ++this.sequence;

    await this.publish({
      kind: "motor",
      ...pose(),
      phase: "contact",
      effector: this.position,
      key: resolved,
      contactId,
    });

    await this.page.keyboard.down(resolved);

    try {
      const audit = await this.page.evaluate(
        (code) => window.__flyKeys?.findLast((event) => event.code === code),
        resolved,
      );

      if (!audit?.trusted) {
        throw new Error("Native key audit failed");
      }

      await this.publish({
        kind: "input",
        key: resolved,
        contactId,
        position: this.position,
        trusted: audit.trusted,
        browserTime: audit.time,
      });
    } finally {
      await this.page.keyboard.up(resolved);
    }

    this.position = [
      this.position[0],
      this.position[1] + 0.09,
      this.position[2],
    ];

    this.hands[hand] = this.position;

    await this.publish({
      kind: "motor",
      ...pose(),
      phase: "release",
      effector: this.position,
      key: resolved,
    });
  }
}
