import {PassThrough, Writable} from "node:stream";
import {describe, expect, it, vi} from "vitest";
import {createMessageConnection, type Message} from "vscode-jsonrpc/node";
import {AppServerClient} from "../codex/AppServerClient";
import {createReader, createWriter, wireLog} from "../codex/transport";

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
        const connection = createMessageConnection(createReader(incoming), createWriter(outgoing));
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
            config: {model_providers: {gateway: {http_headers: {"X-Custom-Credential": "header-value"}, name: "gateway"}}}}});
        for (const secret of ["key-value", "access-value", "refresh-value", "header-value"]) expect(log).not.toContain(secret);
        expect(log).toContain("thread/resume");
        expect(log).toContain("gateway");
    });
});
