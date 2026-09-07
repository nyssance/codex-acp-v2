import {mkdtemp, writeFile, chmod, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {PassThrough, Writable} from "node:stream";
import {describe, expect, it, vi} from "vitest";
import {type Message} from "vscode-jsonrpc/node";
import {AppServerClient} from "../codex/AppServerClient";
import {startCodexProcess} from "../codex/process";
import {createCodexConnection, createReader, createWriter, wireLog} from "../codex/transport";

describe("Codex newline transport", () => {
    it("preserves multilingual text at every possible UTF-8 byte boundary", () => {
        const frame = {method: "notice", params: {text: "你好，世界 🌍 café"}};
        const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
        for (let split = 1; split < bytes.length; split += 1) {
            const stream = new PassThrough();
            const reader = createReader(stream);
            const messages: Message[] = [];
            reader.listen(message => messages.push(message));
            stream.write(bytes.subarray(0, split));
            stream.write(bytes.subarray(split));
            expect(messages).toEqual([{jsonrpc: "2.0", ...frame}]);
            reader.dispose();
            stream.destroy();
        }
    });

    it("handles coalesced frames, blanks, CRLF, and a final frame at EOF", async () => {
        const stream = new PassThrough();
        const reader = createReader(stream);
        const messages: Message[] = [];
        const closed = vi.fn();
        reader.onClose(closed);
        reader.listen(message => messages.push(message));
        stream.end('\n{"id":1,"result":{}}\r\n{"id":2,"result":{}}');
        await new Promise(resolve => stream.on("end", resolve));
        expect(messages).toEqual([{jsonrpc: "2.0", id: 1, result: {}}, {jsonrpc: "2.0", id: 2, result: {}}]);
        expect(closed).toHaveBeenCalledTimes(1);
        reader.dispose();
        expect(stream.listenerCount("data")).toBe(0);
    });

    it("reports malformed frames without exposing their contents and resumes reading", () => {
        const stream = new PassThrough();
        const reader = createReader(stream);
        const errors: Error[] = [];
        const messages: Message[] = [];
        reader.onError(error => errors.push(error));
        reader.listen(message => messages.push(message));
        stream.write('{"apiKey":"private-test-key",bad}\nnull\n[]\n{"id":1,"result":{}}\n');
        expect(errors).toHaveLength(3);
        expect(errors.map(String).join()).not.toContain("private-test-key");
        expect(messages).toHaveLength(1);
        reader.dispose();
        stream.destroy();
    });

    it("waits for write completion and preserves wire order", async () => {
        const frames: string[] = [];
        const callbacks: Array<(error?: Error | null) => void> = [];
        const stream = new Writable({highWaterMark: 1, write(chunk, _encoding, callback) {
            frames.push(chunk.toString());
            callbacks.push(callback);
        }});
        const writer = createWriter(stream);
        const finished = vi.fn();
        const first = writer.write({jsonrpc: "2.0", id: 1, method: "first"} as Message).then(finished);
        const second = writer.write({jsonrpc: "2.0", id: 2, method: "second"} as Message);
        await Promise.resolve();
        expect(finished).not.toHaveBeenCalled();
        expect(frames).toHaveLength(1);
        callbacks[0]!();
        await first;
        callbacks[1]!();
        await second;
        expect(frames).toEqual(['{"id":1,"method":"first"}\n', '{"id":2,"method":"second"}\n']);
        writer.dispose();
        stream.destroy();
    });

    it("rejects pending writes on stream errors", async () => {
        const stream = new Writable({write(_chunk, _encoding, callback) { callback(new Error("broken pipe")); }});
        const writer = createWriter(stream);
        const errors = vi.fn();
        writer.onError(errors);
        await expect(writer.write({jsonrpc: "2.0", method: "test"} as Message)).rejects.toThrow("broken pipe");
        await new Promise(resolve => setImmediate(resolve));
        expect(errors).toHaveBeenCalled();
        writer.dispose();
    });

    it("rejects app-server requests when stdout closes before the child exits", async () => {
        const incoming = new PassThrough();
        const outgoing = new Writable({write(_chunk, _encoding, callback) { callback(); }});
        const {connection} = createCodexConnection(incoming, outgoing);
        const codex = new AppServerClient(connection);
        connection.listen();
        const pending = codex.threadList({});
        const rejected = expect(pending).rejects.toThrow("Connection to Codex was lost");
        incoming.end();
        await rejected;
        connection.dispose();
        outgoing.destroy();
    });

    it("redacts credential fields and arbitrary gateway headers in wire logs", () => {
        const log = wireLog({method: "thread/resume", params: {apiKey: "key-value", access_token: "access-value", refreshToken: "refresh-value",
            config: {model_providers: {gateway: {http_headers: {"X-Custom-Credential": "header-value"}, query_params: {key: "query-value"}, name: "gateway"}}}}});
        for (const secret of ["key-value", "access-value", "refresh-value", "header-value", "query-value"]) expect(log).not.toContain(secret);
        expect(log).toContain("thread/resume");
        expect(log).toContain("gateway");
    });
});


describe("EOF dispatch barrier", () => {
    it("does not wait for an asynchronous incoming request before dispatching later frames", async () => {
        const incoming = new PassThrough();
        const outgoing = new Writable({write(_chunk, _encoding, done) { done(); }});
        const {connection, drained} = createCodexConnection(incoming, outgoing);
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const seen: string[] = [];
        connection.onRequest("approval", () => held);
        connection.onNotification("notice", () => { seen.push("notice"); });
        connection.listen();
        incoming.end('{"id":1,"method":"approval"}\n{"method":"notice"}\n');
        await drained;
        expect(seen).toEqual(["notice"]);
        expect(() => connection.sendRequest("after-close")).toThrow("closed");
        release();
        await new Promise(resolve => setImmediate(resolve));
        connection.dispose(); outgoing.destroy();
    });

    it.skipIf(process.platform === "win32")("waits for stdout after child exit and delivers its final response", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "acp-exit-"));
        const executable = path.join(directory, "codex-fixture");
        const script = `#!${process.execPath}\nconst {spawn} = require("node:child_process");
if (process.argv.includes("--version")) { console.log("codex-cli 0.153.0"); }
else { process.stdin.once("data", data => {
 const id = JSON.parse(data.toString()).id;
 const reply = JSON.stringify({id, result: {data: [], nextCursor: null, backwardsCursor: null}});
 spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write(" + JSON.stringify(reply + "\\n") + "), 50)"], {stdio: ["ignore", 1, 2]});
 process.exit(0);
}); }`;
        await writeFile(executable, script); await chmod(executable, 0o755);
        const child = startCodexProcess(executable);
        try {
            const codex = new AppServerClient(child.connection);
            const response = codex.threadList({});
            await new Promise(resolve => child.process.once("exit", resolve));
            expect(child.exitCode()).toBe(0);
            await expect(response).resolves.toMatchObject({data: []});
            await child.exited;
        } finally {
            child.connection.dispose(); child.process.kill();
            await rm(directory, {recursive: true, force: true});
        }
    });

    it.each(["thread/start", "thread/resume"])("redacts whole MCP env maps in %s", method => {
        const text = wireLog({method, params: {config: {mcp_servers: {sample: {command: "mcp-server", env: {FOO: "canary-foo", PATH: "canary-path", GITHUB_TOKEN: "canary-token"}}}}}});
        expect(text).toContain("mcp-server");
        for (const secret of ["canary-foo", "canary-path", "canary-token"]) expect(text).not.toContain(secret);
    });
});

describe("failed writes during EOF drain", () => {
    it("observes sends after stdin finish without losing an earlier response", async () => {
        const incoming = new PassThrough();
        let requestId: number | undefined;
        const outgoing = new Writable({write(chunk, _encoding, done) { requestId = JSON.parse(chunk.toString()).id; done(); }});
        const {connection, drained} = createCodexConnection(incoming, outgoing);
        const codex = new AppServerClient(connection); connection.listen();
        try {
            const first = codex.threadList({});
            await new Promise<void>(resolve => outgoing.end(resolve));
            const failed = expect(codex.threadList({})).rejects.toThrow("Connection to Codex was lost");
            incoming.end(JSON.stringify({id: requestId, result: {data: [], nextCursor: null}}) + "\n");
            await expect(first).resolves.toMatchObject({data: []});
            await failed; await drained;
        } finally { connection.dispose(); outgoing.destroy(); }
    });

    it("observes EPIPE without the RPC library leaking an async-executor rejection", async () => {
        const incoming = new PassThrough();
        const outgoing = new Writable({write(_chunk, _encoding, done) {
            done(new Error("EPIPE"));
            setImmediate(() => incoming.end());
        }});
        const {connection} = createCodexConnection(incoming, outgoing);
        const codex = new AppServerClient(connection); connection.listen();
        try { await expect(codex.threadList({})).rejects.toThrow("Connection to Codex was lost"); }
        finally { connection.dispose(); outgoing.destroy(); }
    });
});

it("bounds a failed write even when stdout never ends", async () => {
    vi.useFakeTimers();
    const incoming = new PassThrough();
    const outgoing = new Writable({write(_chunk, _encoding, done) { done(); }});
    const {connection} = createCodexConnection(incoming, outgoing);
    const codex = new AppServerClient(connection); connection.listen();
    try {
        await new Promise<void>(resolve => outgoing.end(resolve));
        const failed = expect(codex.threadList({})).rejects.toThrow("Connection to Codex was lost");
        await vi.advanceTimersByTimeAsync(5_000);
        await failed;
    } finally {
        connection.dispose(); incoming.destroy(); outgoing.destroy(); vi.useRealTimers();
    }
});
