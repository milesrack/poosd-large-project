import type { PhysicalFrame, PhysicalKey, Position } from "./contracts.ts";

type KeySpec = [string, string, number?];

// Shared rendering and contact coordinates, in world metres.
export const KEYS: PhysicalKey[] = [];

function row(codes: KeySpec[], z: number, offset = 0) {
  let x = -0.86 + offset;

  for (const [code, label, units = 1] of codes) {
    KEYS.push({
      code,
      label,
      position: [x + units * 0.055, 1.367, z],
      width: units * 0.105,
    });

    x += units * 0.115;
  }
}

row(
  [..."1234567890"]
    .map<KeySpec>((c) => [`Digit${c}`, c])
    .concat([
      ["Minus", "−"],
      ["Equal", "="],
      ["Backspace", "⌫", 1.7],
    ]),
  -0.08,
);

row(
  [..."qwertyuiop"]
    .map<KeySpec>((c) => [`Key${c.toUpperCase()}`, c])
    .concat([
      ["BracketLeft", "["],
      ["BracketRight", "]"],
    ]),
  0.04,
  0.06,
);

row(
  [..."asdfghjkl"]
    .map<KeySpec>((c) => [`Key${c.toUpperCase()}`, c])
    .concat([
      ["Semicolon", ";"],
      ["Quote", "'"],
      ["Enter", "Enter", 1.4],
    ]),
  0.16,
  0.09,
);

row(
  [
    ["ShiftLeft", "Shift", 1.4],
    ...[..."zxcvbnm"].map<KeySpec>((c) => [`Key${c.toUpperCase()}`, c]),
    ["Comma", ","],
    ["Period", "."],
    ["Slash", "/"],
  ],
  0.28,
  0.02,
);

row(
  [
    ["ControlLeft", "Ctrl", 1.3],
    ["AltLeft", "Alt", 1.2],
    ["Space", "Space", 4.5],
    ["ArrowLeft", "←"],
    ["ArrowRight", "→"],
  ],
  0.4,
  0.09,
);

export function restingHands(time: number): Record<"left" | "right", Position> {
  const stroke = Math.sin(time * 7) * 0.035;

  return {
    left: [-0.014, 1.56 - stroke * 0.35, 0.53 - stroke],
    right: [0.014, 1.56 + stroke * 0.35, 0.53 + stroke],
  };
}

export function handPositions(
  frame: PhysicalFrame | null,
  time: number,
  blend: number,
) {
  const resting = restingHands(time);
  const recorded = {
    left: frame?.left_effector,
    right: frame?.right_effector ?? frame?.effector,
  };

  for (const hand of ["left", "right"] as const) {
    const position = recorded[hand];

    if (position) {
      resting[hand] = position.map(
        (value, axis) => value + (resting[hand][axis] - value) * blend,
      ) as Position;
    }
  }

  return resting;
}
