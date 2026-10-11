let generation = 0;

/** Later opens cancel an in-flight message load. */
export function beginMessageOpen(): number {
  generation += 1;
  return generation;
}

export function isCurrentMessageOpen(request: number): boolean {
  return generation === request;
}
