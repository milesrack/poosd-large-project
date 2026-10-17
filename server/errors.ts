export function asError(
  value: unknown,
): Error & { status?: number; stderr?: string } {
  return value instanceof Error ? value : new Error(String(value));
}
