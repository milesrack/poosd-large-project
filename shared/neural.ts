export function sampleNeurons(
  ids: Iterable<number>,
  value: (id: number) => number,
  inputs: readonly number[],
  limit: number,
) {
  const sorted = [...ids].sort(
    (a, b) => Math.abs(value(b)) - Math.abs(value(a)) || a - b,
  );
  const sensory = new Set(inputs);
  const groups: number[][] = [[], []];

  for (const id of sorted) {
    groups[sensory.has(id) ? 0 : 1].push(id);
  }

  const selected = new Set(
    groups.flatMap((group) => group.slice(0, Math.floor(limit / 2))),
  );

  for (const id of sorted) {
    if (selected.size >= limit) {
      break;
    }

    selected.add(id);
  }

  return sorted.filter((id) => selected.has(id));
}
