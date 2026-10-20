import { asError } from "./errors"

/** Stops waiting without leaving an abort listener or an unhandled late rejection. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {})
    return Promise.reject(asError(signal.reason))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup()
      reject(asError(signal.reason))
    }
    const cleanup = () => signal.removeEventListener("abort", abort)
    signal.addEventListener("abort", abort, { once: true })
    operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(asError(error))
      }
    )
  })
}
