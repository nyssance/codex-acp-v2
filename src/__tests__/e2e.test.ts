import {spawn, type ChildProcess} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

/**
 * Live wire test: spawns the agent over stdio against a real `codex app-server`.
 * Enable with `RUN_E2E_TESTS=true`; provide `CODEX_API_KEY` or `OPENAI_API_KEY`
 * unless the machine is already logged in to ChatGPT.
 */
const RUN = process.env["RUN_E2E_TESTS"] === "true";
const ROOT = path.resolve(__dirname, "../..");

type Message = {jsonrpc: "2.0"; id?: number; method?: string; params?: any; result?: any; error?: any};

class StdioClient {
    private readonly child: ChildProcess;
    private readonly pending = new Map<number, (message: Message) => void>();
    private nextId = 1;
    readonly updates: any[] = [];
    private readonly waiters: Array<(update: any) => void> = [];

    constructor(cwd: string) {
        this.child = spawn("bun", ["src/index.ts"], {cwd: ROOT, stdio: ["pipe", "pipe", "inherit"], env: {...process.env}});
        readline.createInterface({input: this.child.stdout!}).on("line", line => this.handle(JSON.parse(line) as Message));
        void cwd;
    }

    request(method: string, params: unknown): Promise<Message> {
        const id = this.nextId++;
        this.child.stdin!.write(`${JSON.stringify({jsonrpc: "2.0", id, method, params})}\n`);
        return new Promise(resolve => this.pending.set(id, resolve));
    }

    notify(method: string, params: unknown): void {
        this.child.stdin!.write(`${JSON.stringify({jsonrpc: "2.0", method, params})}\n`);
    }

    nextUpdate(predicate: (update: any) => boolean, timeoutMs = 120_000): Promise<any> {
        const existing = this.updates.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out waiting for session update")), timeoutMs);
            this.waiters.push(update => {
                if (!predicate(update)) return;
                clearTimeout(timer);
                resolve(update);
            });
        });
    }

    close(): void {
        this.child.stdin!.end();
        setTimeout(() => this.child.kill(), 2_000).unref();
    }

    private handle(message: Message): void {
        if (message.id !== undefined && message.method === undefined) {
            this.pending.get(message.id)?.(message);
            this.pending.delete(message.id);
            return;
        }
        if (message.method === "session/update") {
            this.updates.push(message.params.update);
            for (const waiter of this.waiters) waiter(message.params.update);
            return;
        }
        if (message.method === "session/request_permission" && message.id !== undefined) {
            const allow = message.params.options.find((option: any) => option.kind === "allow_once") ?? message.params.options[0];
            this.child.stdin!.write(`${JSON.stringify({jsonrpc: "2.0", id: message.id, result: {outcome: {outcome: "selected", optionId: allow.optionId}}})}\n`);
            return;
        }
        if (message.id !== undefined) {
            this.child.stdin!.write(`${JSON.stringify({jsonrpc: "2.0", id: message.id, error: {code: -32601, message: "not supported"}})}\n`);
        }
    }
}

describe.skipIf(!RUN)("live codex", {timeout: 180_000}, () => {
    let client: StdioClient;
    let cwd: string;

    beforeAll(async () => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-v2-e2e-"));
        client = new StdioClient(cwd);
        const init = await client.request("initialize", {protocolVersion: 2, info: {name: "e2e", version: "0"}, capabilities: {elicitation: {url: {}, form: {}}}});
        expect(init.result.protocolVersion).toBe(2);
        if (process.env["CODEX_API_KEY"] || process.env["OPENAI_API_KEY"]) {
            const login = await client.request("auth/login", {methodId: "api-key"});
            expect(login.error).toBeUndefined();
        }
    });

    afterAll(() => {
        client?.close();
        fs.rmSync(cwd, {recursive: true, force: true});
    });

    it("runs a prompt through running → chunks → idle", async () => {
        const created = await client.request("session/new", {cwd, mcpServers: []});
        expect(created.error).toBeUndefined();
        const sessionId = created.result.sessionId as string;
        expect(created.result.configOptions.map((option: any) => option.configId)).toContain("model");

        const prompt = await client.request("session/prompt", {sessionId, prompt: [{type: "text", text: "Reply with exactly the single word: pong"}]});
        expect(prompt.result).toEqual({});
        const idle = await client.nextUpdate(update => update.sessionUpdate === "state_update" && update.state === "idle");
        expect(idle.stopReason).toBe("end_turn");
        expect(client.updates[0]).toMatchObject({sessionUpdate: "state_update", state: "running"});
        const text = client.updates
            .filter(update => update.sessionUpdate === "agent_message_chunk")
            .map(update => update.content.text)
            .join("");
        expect(text.toLowerCase()).toContain("pong");

        const closed = await client.request("session/close", {sessionId});
        expect(closed.result).toEqual({});
    });
});
