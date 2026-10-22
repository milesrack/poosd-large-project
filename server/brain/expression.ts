import { validateExpression } from "./policy.ts";

export const POSITION_FEATURES = 6;

export function digitPosition(operand: 0 | 1, place: number) {
  if (
    (operand !== 0 && operand !== 1) ||
    !Number.isSafeInteger(place) ||
    place < 0
  ) {
    throw Error("Invalid digit position");
  }

  return [
    Number(operand === 0),
    Number(operand === 1),
    Math.sin(place),
    Math.cos(place),
    Math.sin(place / 100),
    Math.cos(place / 100),
  ];
}

export function encodeExpression(expression: string) {
  const { left } = validateExpression(expression);
  const operator = left.length;

  return Array.from(expression, (symbol, index) => ({
    symbol,
    position:
      index === operator
        ? undefined
        : digitPosition(
            index < operator ? 0 : 1,
            (index < operator ? operator : expression.length) - index - 1,
          ),
  }));
}
