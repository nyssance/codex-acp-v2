import {StringDecoder} from "node:string_decoder";
import type {Readable, Writable} from "node:stream";
import {Emitter, type DataCallback, type Message, type MessageReader, type MessageWriter, type PartialMessageInfo} from "vscode-jsonrpc/node";
import {logger} from "../util/logger";

/** Redacts structured credentials, including client-supplied gateway headers. */
export function wireLog(value: unknown): string {
    return JSON.stringify(value, (key, nested: unknown) => {
        const normalized = key.replace(/[_-]/g, "").toLowerCase();
        if (/^(apikey|accesskey|accesstoken|refreshtoken|idtoken|secretaccesskey|sessiontoken|authorization|proxyauthorization|password|secret|token|cookie|setcookie|headers|httpheaders)$/.test(normalized)) return "***";
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
    let buffer = "";
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
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
        for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            deliver(line);
        }
    };
    const onClose = () => {
        if (ended) return;
        ended = true;
        closed.fire();
    };
    const onEnd = () => {
        buffer += decoder.end();
        deliver(buffer);
        buffer = "";
        onClose();
    };
    const onError = (error: Error) => errors.fire(error);
    const stop = () => {
        readable.off("data", onData);
        readable.off("end", onEnd);
        readable.off("close", onClose);
        readable.off("error", onError);
        callback = null;
        buffer = "";
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
