import assert from "node:assert/strict";
import test from "node:test";
import { contact, KEYS, trajectory } from "../server/motor.ts";
import type { InputEvent, MotorFrame } from "../shared/contracts.ts";
import { handPositions, restingHands } from "../shared/keyboard.ts";

function pageFixture(page: unknown): ConstructorParameters<typeof Motor>[0] {
  return page as ConstructorParameters<typeof Motor>[0];
}

test("each keystroke reaches its own key and cannot contact from above", () => {
  for (const key of KEYS) {
    assert.equal(contact(key.position), key.code);

    assert.equal(
      contact([key.position[0], key.position[1] + 0.1, key.position[2]]),
      null,
    );

    const path = trajectory([0, 1.58, 0.53], key.code);
    assert.equal(contact(path.at(-1)!), key.code);
  }
});

test("unknown keys never produce a trajectory", () =>
  assert.throws(() => trajectory([0, 1, 0], "X")));

import { Motor } from "../server/motor.ts";

test("native input follows a matching recorded contact and is released", async () => {
  const events: (
    | { kind: "down" | "up"; key: string }
    | { kind: "motor"; phase: string; key: string }
    | { kind: "input"; key: string }
  )[] = [];
  const motor = new Motor(
    pageFixture({
      evaluate: async () => ({ trusted: true, time: 1 }),
      keyboard: {
        down: async (key: string) => {
          events.push({ kind: "down", key });
        },
        up: async (key: string) => {
          events.push({ kind: "up", key });
        },
      },
    }),
    async (event: MotorFrame | InputEvent) => {
      events.push(event);
    },
    () => true,
  );

  await motor.stroke("Digit3");
  const down = events.findIndex((e) => e.kind === "down");
  const preceding = events[down - 1];
  assert.ok(preceding.kind === "motor");
  assert.equal(preceding.phase, "contact");
  assert.equal(events[down - 1].key, "Digit3");
  assert.equal(events[down + 1].kind, "input");
  assert.equal(events[down + 2].kind, "up");
});

test("stopped session cannot emit native input", async () => {
  let called = false;
  const motor = new Motor(
    pageFixture({
      keyboard: {
        down: async () => {
          called = true;
        },
      },
    }),
    async () => {},
    () => false,
  );

  await assert.rejects(() => motor.stroke("Digit0"), /stopped/);
  assert.equal(called, false);
});

test("failed trusted-event audit still releases the key", async () => {
  let released = false;
  const motor = new Motor(
    pageFixture({
      evaluate: async () => ({ trusted: false }),
      keyboard: {
        down: async () => {},
        up: async () => {
          released = true;
        },
      },
    }),
    async () => {},
    () => true,
  );

  await assert.rejects(() => motor.stroke("Digit1"), /audit failed/);
  assert.equal(released, true);
});

test("left and right hands make their own audited contacts and retain the other hand's pose", async () => {
  const packets: (MotorFrame | InputEvent)[] = [];
  const motor = new Motor(
    pageFixture({
      evaluate: async () => ({ trusted: true, time: 1 }),
      keyboard: { down: async () => {}, up: async () => {} },
    }),
    (event) => {
      packets.push(event);
    },
    () => true,
  );

  await motor.stroke("Digit3");
  const leftRelease = packets.findLast((event) => event.kind === "motor");
  await motor.stroke("Digit8");

  const contacts = packets.filter(
    (event): event is MotorFrame =>
      event.kind === "motor" && event.phase === "contact",
  );

  assert.deepEqual(
    contacts.map((event) => event.hand),
    ["left", "right"],
  );

  for (const event of contacts) {
    const hand =
      event.hand === "left" ? event.left_effector : event.right_effector;

    assert.deepEqual(event.effector, hand);
    assert.equal(contact(hand), event.key);

    const input = packets.find(
      (packet) =>
        packet.kind === "input" && packet.contactId === event.contactId,
    );

    assert.ok(input?.kind === "input");
    assert.deepEqual(input.position, hand);
  }

  assert.ok(leftRelease?.kind === "motor");
  assert.deepEqual(contacts[1].left_effector, leftRelease.left_effector);
});

test("the first stroke starts at the visible resting pose instead of teleporting from home", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 5000 });
  const packets: MotorFrame[] = [];
  const motor = new Motor(
    pageFixture({
      evaluate: async () => ({ trusted: true, time: 1 }),
      keyboard: { down: async () => {}, up: async () => {} },
    }),
    (event) => {
      if (event.kind === "motor") {
        packets.push(event);
      }
    },
    () => true,
    3000,
  );

  await motor.stroke("Digit3");
  const rest = restingHands(2);

  assert.deepEqual(
    packets[0].left_effector,
    trajectory(rest.left, "Digit3")[0],
  );

  assert.deepEqual(packets[0].right_effector, rest.right);
});

test("recorded hands hold between strokes and idle hands follow the playback time", () => {
  const frame = {
    left_effector: [-0.4, 1.457, -0.08] as [number, number, number],
    right_effector: [0.18, 1.58, 0.53] as [number, number, number],
  };
  const held = { left: frame.left_effector, right: frame.right_effector };
  assert.deepEqual(handPositions(frame, 0, 0), held);
  assert.deepEqual(handPositions(frame, 10, 0), held);
  const idle = handPositions(frame, 1, 1);
  const rest = restingHands(1);

  for (const hand of ["left", "right"] as const) {
    assert.ok(
      idle[hand].every(
        (value, axis) => Math.abs(value - rest[hand][axis]) < 1e-12,
      ),
    );
  }
  assert.notDeepEqual(handPositions(frame, 1, 1), handPositions(frame, 2, 1));
  assert.deepEqual(handPositions(null, 1, 0), restingHands(1));
  assert.deepEqual(
    handPositions({ effector: frame.right_effector }, 1, 0).right,
    frame.right_effector,
  );
});
