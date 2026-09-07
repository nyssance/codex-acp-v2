import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {spawn} from "node:child_process";
import {mkdtemp, writeFile, chmod, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {Readable, Writable} from "node:stream";
import {expect, it} from "vitest";
import {ProtocolOracle} from "./protocolOracle";

it("speaks ACP v2 over real stdio with a deterministic Codex process", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "acp stdio "));
    const windows = process.platform === "win32";
    const executable = path.join(directory, windows ? "codex.cmd" : "codex");
    const fixture = path.resolve("src/__tests__/fakeCodex.ts");
    await writeFile(executable, windows ? `@bun "${fixture}" %*\r\n` : `#!/usr/bin/env bun\nimport ${JSON.stringify(fixture)};\n`);
    if (!windows) await chmod(executable, 0o755);
    const binary = process.env["SMOKE_BINARY"];
    const child = spawn(binary ? path.resolve(binary) : "bun", binary ? [] : ["src/index.ts"], {
        stdio: ["pipe", "pipe", "pipe"], env: {...process.env, CODEX_PATH: executable},
    });
    let stderr = "";
    child.stderr.on("data", chunk => {stderr += chunk.toString();});
    const exited = new Promise<number | null>(resolve => child.on("close", resolve));
    const oracle = new ProtocolOracle();
    let finish!: () => void;
    const idle = new Promise<void>(resolve => {finish = resolve;});
    const app = acp.client({name: "stdio-test"}).onNotification("session/update", ({params}) => {
        oracle.accept(params.sessionId, params.update);
        if (acp.SessionUpdate.isStateUpdate(params.update) && params.update.state === "idle") finish();
    });
    try {
        await app.connectWith(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>), async client => {
            const init = await client.request("initialize", {protocolVersion: 2, info: {name: "stdio-test", version: "1"}});
            expect(init.protocolVersion).toBe(2);
            const session = await client.request("session/new", {cwd: directory, mcpServers: []});
            await client.request("session/prompt", {sessionId: session.sessionId, prompt: [{type: "text", text: "hello"}]});
            await idle;
            expect(oracle.messages.get(`${session.sessionId}:answer`)).toBe("你好 🌍 fixture");
            expect(oracle.issues).toEqual([]);
            await client.request("session/close", {sessionId: session.sessionId});
        });
    } finally {
        child.stdin.end();
        const timer = setTimeout(() => child.kill(), 2_000);
        await exited;
        clearTimeout(timer);
        await rm(directory, {recursive: true, force: true});
    }
    expect(stderr).toBe("");
}, 15_000);
