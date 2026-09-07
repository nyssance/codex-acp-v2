import {StringDecoder} from "node:string_decoder";
import type {Readable, Writable} from "node:stream";
import {createMessageConnection, Emitter, type DataCallback, type Message, type MessageReader, type MessageWriter, type PartialMessageInfo} from "vscode-jsonrpc/node";
import {logger} from "../util/logger";

/** Redacts structured credentials, including client-supplied gateway headers. */
export function wireLog(value: unknown): string {
    return JSON.stringify(value, (key, nested: unknown) => {
        const normalized = key.replace(/[_-]/g, "").toLowerCase();
        if (/^(apikey|accesskey|accesstoken|refreshtoken|idtoken|secretaccesskey|sessiontoken|authorization|proxyauthorization|password|secret|token|cookie|setcookie|headers|httpheaders|env|queryparams)$/.test(normalized)) return "***";
        return nested;
    });
}

/** Codex uses newline JSON-RPC without the jsonrpc envelope field. */
export function createWriter(writable: Writable): MessageWriter {
    const errors = new Emitter<[Error, Message | undefined, number | undefined]>();
    const closed = new Emitter<void>();
    const pending = new Set<(error: Error) => void>();
    let ended = false;
    const onError = (error: Error) => {
        for (const reject of [...pending]) reject(error);
        errors.fire([error, undefined, undefined]);
    };
    const onClose = () => {
        if (ended) return;
        ended = true;
        for (const reject of [...pending]) reject(new Error("Codex input stream closed"));
        closed.fire();
    };
    writable.on("error", onError);
    writable.on("close", onClose);
    writable.on("finish", onClose);
    return {
        write(message) {
            if (ended || writable.destroyed || writable.writableEnded) return Promise.reject(new Error("Codex input stream is closed"));
            const {jsonrpc: _jsonrpc, ...frame} = message as Message & {jsonrpc?: string};
            if (logger.enabled) logger.log("[codex <-]", {line: wireLog(frame)});
            return new Promise<void>((resolve, reject) => {
                const fail = (error: Error) => { pending.delete(fail); reject(error); };
                pending.add(fail);
                try {
                    // Resolve only after the stream flushes this frame, propagating write failures.
                    writable.write(`${JSON.stringify(frame)}\n`, error => {
                        pending.delete(fail);
                        if (error) reject(error);
                        else resolve();
                    });
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            });
        },
        end() { writable.end(); },
        onError: errors.event,
        onClose: closed.event,
        dispose() {
            onClose();
            writable.off("error", onError);
            writable.off("close", onClose);
            writable.off("finish", onClose);
            errors.dispose();
            closed.dispose();
        },
    };
}

export function createReader(readable: Readable): MessageReader {
    const errors = new Emitter<Error>();
    const closed = new Emitter<void>();
    const partial = new Emitter<PartialMessageInfo>();
    const decoder = new StringDecoder("utf8");
    let fragments: string[] = [];
    let ended = false;
    let callback: DataCallback | null = null;
    const deliver = (line: string) => {
        if (!line.trim()) return;
        let message: Message;
        try {
            const parsed: unknown = JSON.parse(line);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected an object");
            const frame = parsed as Record<string, unknown>;
            if (frame["jsonrpc"] === undefined) frame["jsonrpc"] = "2.0";
            if (logger.enabled) logger.log("[codex ->]", {line: wireLog(frame)});
            message = frame as unknown as Message;
        } catch {
            // Malformed frames may contain credentials; neither the frame nor parser excerpts are logged.
            const error = new Error("Malformed JSON-RPC frame from Codex");
            logger.error(error.message, error);
            errors.fire(error);
            return;
        }
        callback?.(message);
    };
    const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        let offset = 0;
        for (;;) {
            const newline = text.indexOf("\n", offset);
            if (newline < 0) break;
            const part = text.slice(offset, newline);
            const line = fragments.length ? fragments.join("") + part : part;
            fragments = [];
            deliver(line);
            offset = newline + 1;
        }
        if (offset < text.length) fragments.push(text.slice(offset));
    };
    const onClose = () => {
        if (ended) return;
        ended = true;
        closed.fire();
    };
    const onEnd = () => {
        fragments.push(decoder.end());
        deliver(fragments.join(""));
        fragments = [];
        onClose();
    };
    const onError = (error: Error) => errors.fire(error);
    const stop = () => {
        readable.off("data", onData);
        readable.off("end", onEnd);
        readable.off("close", onClose);
        readable.off("error", onError);
        callback = null;
        fragments = [];
    };
    return {
        listen(receive) {
            callback = receive;
            readable.on("data", onData);
            readable.on("end", onEnd);
            readable.on("close", onClose);
            readable.on("error", onError);
            return {dispose: stop};
        },
        onError: errors.event,
        onClose: closed.event,
        onPartialMessage: partial.event,
        dispose() { stop(); errors.dispose(); closed.dispose(); partial.dispose(); },
    };
}

/** Drain received frames through the RPC dispatcher before publishing EOF. Async
 * request handlers are deliberately not awaited: they may be waiting on a user. */
export function createCodexConnection(readable: Readable, writable: Writable) {
    const reader = createReader(readable);
    const writer = createWriter(writable);
    const closed = new Emitter<void>();
    let queued = 0;
    let eof = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveDrained!: () => void;
    const drained = new Promise<void>(resolve => { resolveDrained = resolve; });
    const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        closed.fire();
        resolveDrained();
    };
    const check = () => {
        if (eof && queued === 0) setImmediate(() => {
            if (queued === 0) finish();
        });
    };
    reader.onClose(() => {
        eof = true;
        timer ??= setTimeout(() => {
            logger.error("Codex dispatch drain deadline exceeded", new Error(`Undispatched frames: ${queued}`));
            finish();
        }, 5_000);
        check();
    });
    // A broken stdin must not discard responses still arriving on stdout.
    const inputFailed = () => {
        if (finished || timer) return;
        timer = setTimeout(() => {
            logger.error("Codex stdout did not close after stdin", new Error("Transport shutdown deadline exceeded"));
            finish();
        }, 5_000);
    };
    writer.onClose(inputFailed);
    // JSON-RPC may consume cancellation controls synchronously without the strategy.
    const counted = (message: Message) => !("method" in message && message.method === "$/cancelRequest");
    const connection = createMessageConnection({
        ...reader,
        onClose: closed.event,
        listen(receive) { return reader.listen(message => { if (counted(message)) queued += 1; receive(message); }); },
    }, {
        ...writer,
        onClose: () => ({dispose() {}}),
        async write(message) {
            try { await writer.write(message); }
            catch (error) {
                // vscode-jsonrpc rethrows write failures inside an async Promise executor.
                // Let bounded shutdown reject its pending requests instead of leaking that rejection.
                logger.error("Codex write failed; draining stdout before disconnect", error);
                inputFailed();
                await drained;
            }
        },
    }, undefined, {
        messageStrategy: {handleMessage(message, next) {
            try { return next(message); }
            finally { if (counted(message)) queued -= 1; check(); }
        }},
    });
    connection.onDispose(() => { finished = true; clearTimeout(timer); resolveDrained(); closed.dispose(); });
    return {connection, drained};
}
