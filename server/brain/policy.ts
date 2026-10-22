export type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

export type ArithmeticAction = Digit | "-" | "end";

export interface ArithmeticPolicy {
  readonly limits: { maxKeys: number };
  resetRun(): void;
  beginProblem(expression: string, rejected?: readonly string[]): void;
  nextAction(): ArithmeticAction;
}

export function validateExpression(expression: string) {
  if (typeof expression !== "string" || expression.length > 256) {
    throw Error("Expression exceeds the 256-character request limit");
  }

  const parts = /^(-?\d+)([+*/-])(-?\d+)$/.exec(expression);

  if (!parts) {
    throw Error("Expected two integer operands and one operator");
  }

  return { left: parts[1], operation: parts[2], right: parts[3] };
}

export function decodePolicy(
  model: ArithmeticPolicy,
  expression: string,
  onAction?: (action: ArithmeticAction) => void,
  rejected: readonly string[] = [],
) {
  const { maxKeys } = model.limits;
  validateExpression(expression);

  if (!Number.isInteger(maxKeys) || maxKeys < 2 || maxKeys > 256) {
    throw Error("Invalid key budget");
  }

  model.beginProblem(expression, rejected);
  let answer = "";
  const keys: string[] = [];

  for (let i = 0; i < maxKeys; i++) {
    const action = model.nextAction();
    onAction?.(action);

    if (action === "end") {
      return { answer, keys: [...keys, "Enter"], terminated: true };
    }

    answer += action;
    keys.push(action);
  }

  return { answer, keys, terminated: false };
}

export function runPolicy(
  model: ArithmeticPolicy,
  expression: string,
  onAction?: (action: ArithmeticAction) => void,
  rejected: readonly string[] = [],
) {
  const result = decodePolicy(model, expression, onAction, rejected);

  if (!result.terminated) {
    throw Error("Model exceeded its answer key budget");
  }

  if (
    !/^-?\d+$/.test(result.answer) ||
    result.keys.some((key) => key !== "Enter" && !/^[0-9-]$/.test(key))
  ) {
    throw Error("Model emitted an empty or invalid answer");
  }

  return result;
}
