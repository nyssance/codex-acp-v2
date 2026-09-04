import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createRequire} from "node:module";
import type {Readable, Writable} from "node:stream";
import * as rpc from "vscode-jsonrpc/node";
import type {
    DataCallback,
    Disposable,
    Message,
    MessageConnection,
    MessageReader,
    MessageWriter,
    PartialMessageInfo,
} from "vscode-jsonrpc/node";
import {logger} from "../util/logger";

export interface CodexProcess {
    readonly connection: MessageConnection;
    readonly process: ChildProcessWithoutNullStreams;
    /** Resolves with the exit code once the Codex process is gone. */
    readonly exited: Promise<number | null>;
    /** Last few KB of stderr, for diagnostics when the process dies. */
    recentStderr(): string;
    exitCode(): number | null;
}

const STDERR_RETAIN_BYTES = 8 * 1024;

/**
 * Spawns `codex app-server` and wires a newline-delimited JSON-RPC connection to it.
 * `codexPath` overrides the bundled `@openai/codex` executable.
 */
export function startCodexProcess(codexPath?: string, env: NodeJS.ProcessEnv = process.env): CodexProcess {
    const child = codexPath
        ? (process.platform === "win32"
            ? spawn(`"${codexPath}" app-server`, {shell: true, env})
            : spawn(codexPath, ["app-server"], {env}))
        : spawn(process.execPath, [createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js"), "app-server"], {env});

    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-STDERR_RETAIN_BYTES);
        logger.log("[codex stderr]", {data: data.toString()});
    });

    const connection = rpc.createMessageConnection(createReader(child.stdout), createWriter(child.stdin));
    connection.listen();
    const exited = new Promise<number | null>((resolve) => {
        child.on("exit", (code, signal) => {
            logger.log("codex exited", {code, signal});
            connection.dispose();
            resolve(code);
        });
    });

    return {
        connection,
        process: child,
        exited,
        recentStderr: () => stderr.trim(),
        exitCode: () => child.exitCode,
    };
}

/** Keeps credentials out of the wire log. */
function redactSecrets(line: string): string {
    return line.replace(/"(apiKey|accessToken|secretAccessKey|sessionToken)":"[^"]*"/g, '"$1":"***"');
}

/**
 * Codex app-server speaks JSON-RPC without the `jsonrpc` envelope field. The reader
 * adds it so vscode-jsonrpc accepts the frames; the writer strips it again.
 */
function createWriter(writable: Writable): MessageWriter {
    return {
        async write(message: Message) {
            const {jsonrpc: _jsonrpc, ...frame} = message as Message & {jsonrpc?: string};
            const line = JSON.stringify(frame);
            logger.log("[codex <-]", {line: redactSecrets(line)});
            writable.write(`${line}\n`);
        },
        end() {
            writable.end();
        },
        onError: new rpc.Emitter<[Error, Message | undefined, number | undefined]>().event,
        onClose: new rpc.Emitter<void>().event,
        dispose() {},
    };
}

function createReader(readable: Readable): MessageReader {
    return {
        listen(callback: DataCallback): Disposable {
            let buffer = "";
            const onData = (chunk: Buffer) => {
                buffer += chunk.toString();
                for (;;) {
                    const newline = buffer.indexOf("\n");
                    if (newline < 0) break;
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (line.length === 0) continue;
                    logger.log("[codex ->]", {line: redactSecrets(line)});
                    try {
                        const message = JSON.parse(line) as Record<string, unknown>;
                        if (message["jsonrpc"] === undefined) message["jsonrpc"] = "2.0";
                        callback(message as unknown as Message);
                    } catch (error) {
                        logger.error("Malformed JSON-RPC frame from codex", error, {line});
                    }
                }
            };
            readable.on("data", onData);
            return {
                dispose() {
                    readable.off("data", onData);
                },
            };
        },
        onError: new rpc.Emitter<Error>().event,
        onClose: new rpc.Emitter<void>().event,
        onPartialMessage: new rpc.Emitter<PartialMessageInfo>().event,
        dispose() {},
    };
}
