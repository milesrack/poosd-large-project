import { randomSource } from "../server/brain/random.ts";
import type { Operation } from "../shared/contracts.ts";

interface ArithmeticExample {
  a: number;
  b: number;
  answer: number;
  operation: Operation;
  family: [number, number];
}

export function groupKey(row: ArithmeticExample) {
  return [...row.family].sort((a, b) => a - b).join(":");
}

export function arithmeticQuestions(
  a: number,
  b: number,
  inverseOperand: "left" | "right" = "right",
): ArithmeticExample[] {
  const family: [number, number] = [a, b];
  const divisor = inverseOperand === "left" ? a : b;
  const inverseAnswer = inverseOperand === "left" ? b : a;

  return [
    { a, b, answer: a + b, operation: "+", family },
    { a: a + b, b: divisor, answer: inverseAnswer, operation: "-", family },
    { a, b, answer: a * b, operation: "*", family },
    ...(divisor
      ? [
          {
            a: a * b,
            b: divisor,
            answer: inverseAnswer,
            operation: "/" as const,
            family,
          },
        ]
      : []),
  ];
}

export function arithmeticSplit() {
  const groups: [number, number][] = [];

  for (let a = 0; a <= 9; a++) {
    for (let b = a; b <= 9; b++) {
      groups.push([a, b]);
    }
  }

  const random = randomSource(20261018);

  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [groups[i], groups[j]] = [groups[j], groups[i]];
  }

  const expand = (pairs: [number, number][]) =>
    pairs.flatMap(([a, b]) => [
      ...arithmeticQuestions(a, b),
      ...(a === b ? [] : arithmeticQuestions(b, a)),
    ]);
  const extrapolation: ArithmeticExample[] = [];

  for (let a = 10; a <= 18; a++) {
    for (let b = 10; b <= 18; b++) {
      extrapolation.push(...arithmeticQuestions(a, b));
    }
  }

  return {
    training: expand(groups.slice(0, 33)),
    validation: expand(groups.slice(33, 44)),
    test: expand(groups.slice(44)),
    extrapolation,
  };
}
