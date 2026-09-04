import {spawn, spawnSync, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createRequire} from "node:module";
import packageJson from "../../package.json";
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
 * The oldest Codex this agent is written against: the app-server types under
 * `src/app-server` are generated from exactly the `@openai/codex` release the
 * optional dependency names (`bun run generate-types`), so that range is the
 * single source of the floor. Older servers speak a schema no test here covers.
 */
export const MINIMUM_CODEX_VERSION = packageJson.optionalDependencies["@openai/codex"].replace(/^[\^~]/, "");

/** The `codex --version` line is `codex-cli <semver>`; anything else is not a Codex CLI. */
export function parseCodexVersion(output: string): [number, number, number] {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
    if (match === null) throw new Error(`Could not read a Codex version from: ${output.trim() || "(empty output)"}`);
    const [, major, minor, patch] = match;
    return [Number(major), Number(minor), Number(patch)];
}

export function assertCodexVersion(output: string, minimum: string = MINIMUM_CODEX_VERSION): void {
    const actual = parseCodexVersion(output);
    const floor = parseCodexVersion(minimum);
    const [actualMajor, actualMinor, actualPatch] = actual;
    const [floorMajor, floorMinor, floorPatch] = floor;
    const olderThanFloor = actualMajor !== floorMajor
        ? actualMajor < floorMajor
        : actualMinor !== floorMinor
            ? actualMinor < floorMinor
            : actualPatch < floorPatch;
    if (olderThanFloor) {
        throw new Error(
            `Codex ${actual.join(".")} is older than the ${minimum} this agent is generated against; `
            + "upgrade the Codex CLI (npm install -g @openai/codex or brew upgrade codex)",
        );
    }
}

/**
 * One Codex launcher: the executable `CODEX_PATH` names, or the `@openai/codex`
 * optional dependency when it is installed. Neither = fail loud; there is no
 * silent download and no other place to look.
 */
export function resolveCodexLauncher(codexPath: string | undefined): {command: string; prefixArgs: string[]; shell: boolean} {
    if (codexPath !== undefined) {
        return process.platform === "win32"
            ? {command: `"${codexPath}"`, prefixArgs: [], shell: true}
            : {command: codexPath, prefixArgs: [], shell: false};
    }
    try {
        return {command: process.execPath, prefixArgs: [createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js")], shell: false};
    } catch (error) {
        throw new Error(
            "No Codex CLI: set CODEX_PATH to an installed Codex executable, or install the optional "
            + `@openai/codex dependency (${String(error)})`,
        );
    }
}

/**
 * Spawns `codex app-server` and wires a newline-delimited JSON-RPC connection to it.
 * `codexPath` overrides the bundled `@openai/codex` executable. The Codex version is
 * checked first: a server older than the generated schema fails here, not mid-turn.
 */
export function startCodexProcess(codexPath?: string, env: NodeJS.ProcessEnv = process.env): CodexProcess {
    const launcher = resolveCodexLauncher(codexPath);
    const probe = spawnSync(launcher.command, [...launcher.prefixArgs, "--version"], {shell: launcher.shell, env, encoding: "utf8"});
    if (probe.error !== undefined) throw new Error(`Could not run Codex (${launcher.command}): ${probe.error.message}`);
    assertCodexVersion(probe.stdout.length > 0 ? probe.stdout : probe.stderr);
    const child = launcher.shell
        ? spawn(`${launcher.command} app-server`, {shell: true, env})
        : spawn(launcher.command, [...launcher.prefixArgs, "app-server"], {env});

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
