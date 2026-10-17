export function randomSource(seed: number) {
  let state = seed >>> 0;

  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;

    return state / 2 ** 32;
  };
}
