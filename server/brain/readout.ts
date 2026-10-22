export function readoutSize(inputs: number, outputs: number, hidden: number) {
  return (
    (hidden ? hidden * (inputs + 1) : 0) + outputs * ((hidden || inputs) + 1)
  );
}

interface ReadoutPass {
  input: Float64Array;
  hidden?: Float64Array;
  logits: Float64Array;
}

function dense(
  parameters: Float64Array,
  start: number,
  input: Float64Array,
  size: number,
) {
  const width = input.length + 1;

  return Float64Array.from({ length: size }, (_, unit) => {
    const offset = start + unit * width;
    let value = parameters[offset + input.length];

    for (let i = 0; i < input.length; i++) {
      value += parameters[offset + i] * input[i];
    }

    return value;
  });
}

export function readout(
  parameters: Float64Array,
  start: number,
  input: Float64Array,
  outputs: number,
  hiddenSize: number,
): ReadoutPass {
  const hidden = hiddenSize
    ? dense(parameters, start, input, hiddenSize).map((value) =>
        Math.max(0, value),
      )
    : undefined;
  const offset = start + (hiddenSize ? hiddenSize * (input.length + 1) : 0);

  return {
    input,
    hidden,
    logits: dense(parameters, offset, hidden ?? input, outputs),
  };
}

function backwardDense(
  parameters: Float64Array,
  start: number,
  input: Float64Array,
  deltas: Float64Array,
  gradient: Float64Array,
) {
  const error = new Float64Array(input.length);
  const width = input.length + 1;

  for (let unit = 0; unit < deltas.length; unit++) {
    const offset = start + unit * width;
    gradient[offset + input.length] += deltas[unit];

    for (let i = 0; i < input.length; i++) {
      gradient[offset + i] += deltas[unit] * input[i];
      error[i] += deltas[unit] * parameters[offset + i];
    }
  }

  return error;
}

export function backpropReadout(
  parameters: Float64Array,
  start: number,
  pass: ReadoutPass,
  deltas: Float64Array,
  gradient: Float64Array,
) {
  const { input, hidden } = pass;
  const offset = start + (hidden ? hidden.length * (input.length + 1) : 0);
  const error = backwardDense(
    parameters,
    offset,
    hidden ?? input,
    deltas,
    gradient,
  );

  if (!hidden) {
    return error;
  }

  for (let i = 0; i < error.length; i++) {
    error[i] *= Number(hidden[i] > 0);
  }

  return backwardDense(parameters, start, input, error, gradient);
}
