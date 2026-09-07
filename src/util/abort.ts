/** Stops waiting without leaving an abort listener or an unhandled late rejection. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        void operation.catch(() => {});
        return Promise.reject(signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
        const abort = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, {once: true});
        operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}
