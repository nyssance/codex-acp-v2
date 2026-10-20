/** Turns a caught or abort-reason value into an Error: Errors pass through, anything else becomes the message. */
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
