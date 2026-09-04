import {spawn, type ChildProcess} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {startFakeGateway, type FakeGateway} from "./fakeGateway";

/**
 * Live wire suite: drives the agent over stdio against a real `codex app-server`.
 * Enable with `RUN_E2E_TESTS=true`; provide `CODEX_API_KEY` or `OPENAI_API_KEY`
 * unless the machine is already logged in to ChatGPT. Prompts are phrased so the
 * model's behaviour is as deterministic as a live model allows.
 */
const RUN = process.env["RUN_E2E_TESTS"] === "true";
const ROOT = path.resolve(__dirname, "../..");
const TURN_TIMEOUT_MS = 120_000;

type Message = {jsonrpc: "2.0"; id?: number; method?: string; params?: any; result?: any; error?: any};
// Wire frames are asserted loosely on purpose; the unit suite covers exact shapes.
type Update = any;

class StdioClient {
    private readonly child: ChildProcess;
    private readonly pending = new Map<number, (message: Message) => void>();
    private nextId = 1;
    readonly updates: Update[] = [];
    readonly permissionRequests: any[] = [];
    private readonly waiters: Array<(update: Update) => void> = [];
    permissionResponder: (request: any) => {outcome: "selected"; optionId: string} | {outcome: "cancelled"} = (request) => {
        const allow = request.options.find((option: any) => option.kind === "allow_once") ?? request.options[0];
        return {outcome: "selected", optionId: allow.optionId};
    };

    constructor() {
        this.child = spawn("bun", ["src/index.ts"], {cwd: ROOT, stdio: ["pipe", "pipe", "inherit"], env: {...process.env}});
        readline.createInterface({input: this.child.stdout!}).on("line", line => this.handle(JSON.parse(line) as Message));
    }

    request(method: string, params: unknown): Promise<Message> {
        const id = this.nextId++;
        this.child.stdin!.write(`${JSON.stringify({jsonrpc: "2.0", id, method, params})}\n`);
        return new Promise(resolve => this.pending.set(id, resolve));
    }

    async call<T = any>(method: string, params: unknown): Promise<T> {
        const message = await this.request(method, params);
        if (message.error) throw new Error(`${method} failed: ${JSON.stringify(message.error)}`);
        return message.result as T;
    }

    notify(method: string, params: unknown): void {
        this.child.stdin!.write(`${JSON.stringify({jsonrpc: "2.0", method, params})}\n`);
    }

    mark(): number {
        return this.updates.length;
    }

    since(mark: number, sessionId?: string): Update[] {
        return this.updates.slice(mark).filter(update => sessionId === undefined || update.sessionId === sessionId);
    }

    nextUpdate(predicate: (update: Update) => boolean, timeoutMs = TURN_TIMEOUT_MS): Promise<Update> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out waiting for session update")), timeoutMs);
            this.waiters.push(update => {
                if (!predicate(update)) return;
                clearTimeout(timer);
                resolve(update);
            });
        });
    }

    idle(sessionId: string, timeoutMs = TURN_TIMEOUT_MS): Promise<Update> {
        return this.nextUpdate(update => update.sessionId === sessionId && update.sessionUpdate === "state_update" && update.state === "idle", timeoutMs);
    }

    text(mark: number, sessionId: string): string {
        return this.since(mark, sessionId)
            .filter(update => update.sessionUpdate === "agent_message_chunk" && !update._meta?.codex?.notice)
            .map(update => update.content.text as string)
            .join("");
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
            const update = {sessionId: message.params.sessionId, ...message.params.update} as Update;
            this.updates.push(update);
            for (const waiter of [...this.waiters]) waiter(update);
            return;
        }
        if (message.method === "session/request_permission" && message.id !== undefined) {
            this.permissionRequests.push(message.params);
            this.child.stdin!.write(`${JSON.stringify({jsonrpc: "2.0", id: message.id, result: {outcome: this.permissionResponder(message.params)}})}\n`);
            return;
        }
        if (message.id !== undefined) {
            this.child.stdin!.write(`${JSON.stringify({jsonrpc: "2.0", id: message.id, error: {code: -32601, message: "not supported"}})}\n`);
        }
    }
}

describe.skipIf(!RUN)("live codex", {timeout: 240_000}, () => {
    let client: StdioClient;
    let cwd: string;
    let firstSessionId: string;

    beforeAll(async () => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-v2-e2e-"));
        client = new StdioClient();
        const init = await client.call("initialize", {protocolVersion: 2, info: {name: "e2e", version: "0"}, capabilities: {elicitation: {url: {}, form: {}}}});
        expect(init.protocolVersion).toBe(2);
        expect(init.capabilities.providers).toEqual({});
        if (process.env["CODEX_API_KEY"] || process.env["OPENAI_API_KEY"]) {
            await client.call("auth/login", {methodId: "api-key"});
        }
    });

    afterAll(() => {
        client?.close();
        fs.rmSync(cwd, {recursive: true, force: true});
    });

    it("runs a prompt through running, chunks, usage, and idle", async () => {
        const created = await client.call("session/new", {cwd, mcpServers: []});
        firstSessionId = created.sessionId;
        expect(created.configOptions.map((option: any) => option.configId)).toEqual(expect.arrayContaining(["mode", "model", "effort"]));
        const mark = client.mark();
        expect(await client.call("session/prompt", {sessionId: firstSessionId, prompt: [{type: "text", text: "Reply with exactly the single word: pong"}]})).toEqual({});
        const idle = await client.idle(firstSessionId);
        expect(idle.stopReason).toBe("end_turn");
        expect(idle.usage.totalTokens).toBeGreaterThan(0);
        const frames = client.since(mark, firstSessionId);
        expect(frames[0]).toMatchObject({sessionUpdate: "state_update", state: "running"});
        expect(frames.some(update => update.sessionUpdate === "user_message")).toBe(true);
        expect(client.text(mark, firstSessionId).toLowerCase()).toContain("pong");
        expect(frames.find(update => update.sessionUpdate === "session_info_update")?.title).toBe("Reply with exactly the single word: pong");
    });

    it("applies config options and answers /status locally", async () => {
        const response = await client.call("session/set_config_option", {sessionId: firstSessionId, configId: "effort", type: "id", value: "low"});
        expect(response.configOptions.find((option: any) => option.configId === "effort").currentValue).toBe("low");
        const mark = client.mark();
        await client.call("session/prompt", {sessionId: firstSessionId, prompt: [{type: "text", text: "/status"}]});
        await client.idle(firstSessionId, 10_000);
        expect(client.text(mark, firstSessionId)).toContain("(low)");
    });

    it("cancels a running turn with stopReason cancelled", async () => {
        const created = await client.call("session/new", {cwd, mcpServers: []});
        const sessionId = created.sessionId as string;
        await client.call("session/prompt", {sessionId, prompt: [{type: "text", text: "Write a 2000-word essay about the history of computing, one paragraph per decade."}]});
        await client.nextUpdate(update => update.sessionId === sessionId && update.sessionUpdate === "agent_message_chunk", 60_000).catch(() => undefined);
        client.notify("session/cancel", {sessionId});
        const idle = await client.idle(sessionId, 30_000);
        expect(idle.stopReason).toBe("cancelled");
        await client.call("session/close", {sessionId});
    });

    it("routes command approvals through session/request_permission with requires_action", async () => {
        const created = await client.call("session/new", {cwd, mcpServers: []});
        const sessionId = created.sessionId as string;
        await client.call("session/set_config_option", {sessionId, configId: "mode", type: "id", value: "read-only"});
        const mark = client.mark();
        const requestsBefore = client.permissionRequests.length;
        await client.call("session/prompt", {sessionId, prompt: [{type: "text", text: "Run this exact shell command and show me its output: curl -sS https://example.com | head -c 60"}]});
        const idle = await client.idle(sessionId);
        expect(idle.stopReason).toBe("end_turn");
        const requests = client.permissionRequests.slice(requestsBefore);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests[0]).toMatchObject({sessionId, title: expect.any(String), subject: {type: "tool_call", toolCall: {toolCallId: expect.any(String)}}});
        expect(requests[0].options.some((option: any) => option.kind === "allow_once")).toBe(true);
        const states = client.since(mark, sessionId).filter(update => update.sessionUpdate === "state_update").map(update => update.state);
        expect(states).toContain("requires_action");
        expect(states.at(-1)).toBe("idle");
        expect(client.since(mark, sessionId).some(update => update.sessionUpdate === "terminal_update")).toBe(true);
        await client.call("session/close", {sessionId});
    });

    it("replays history on resume, forks, and deletes", async () => {
        await client.call("session/close", {sessionId: firstSessionId});
        const mark = client.mark();
        const resumed = await client.call("session/resume", {sessionId: firstSessionId, cwd, replayFrom: {type: "start"}, mcpServers: []});
        expect(resumed.configOptions.length).toBeGreaterThan(0);
        const replay = client.since(mark, firstSessionId);
        expect(replay.some(update => update.sessionUpdate === "user_message" && update.content[0]?.text === "Reply with exactly the single word: pong")).toBe(true);
        expect(replay.some(update => update.sessionUpdate === "agent_message")).toBe(true);
        expect(replay.find(update => update.sessionUpdate === "session_info_update")?.title).toBeTruthy();

        const forkMark = client.mark();
        const forked = await client.call("session/fork", {sessionId: firstSessionId, cwd, mcpServers: []});
        expect(forked.sessionId).not.toBe(firstSessionId);
        expect(client.since(forkMark, forked.sessionId).some(update => update.sessionUpdate === "agent_message")).toBe(true);

        await client.call("session/close", {sessionId: firstSessionId});
        expect(await client.call("session/delete", {sessionId: forked.sessionId})).toEqual({});
    });

    it("routes a session through a client-configured gateway", async () => {
        const gateway: FakeGateway = await startFakeGateway({token: "e2e-token", reply: "pong from the fake gateway"});
        try {
            await client.call("providers/set", {
                providerId: "openai",
                apiType: "openai",
                baseUrl: gateway.baseUrl,
                headers: {authorization: "Bearer e2e-token"},
                _meta: {alwith: {model: "fake-model", models: [{id: "fake-model", label: "Fake model"}]}},
            });
            const listed = await client.call("providers/list", {});
            expect(listed.providers[0].current.baseUrl).toBe(gateway.baseUrl);
            const created = await client.call("session/new", {cwd, mcpServers: []});
            const sessionId = created.sessionId as string;
            expect(created.configOptions.find((option: any) => option.configId === "model").currentValue).toBe("fake-model");
            const mark = client.mark();
            await client.call("session/prompt", {sessionId, prompt: [{type: "text", text: "ping"}]});
            const idle = await client.idle(sessionId, 60_000);
            expect(idle.stopReason).toBe("end_turn");
            expect(client.text(mark, sessionId)).toBe("pong from the fake gateway");
            expect(gateway.requests.map(request => [request.path, request.authorization, request.body["model"]])).toEqual([["/v1/responses", "Bearer e2e-token", "fake-model"]]);
            await client.call("session/close", {sessionId});
            await client.call("providers/disable", {providerId: "openai"});
            expect((await client.call("providers/list", {})).providers[0].current.baseUrl).toBe("https://api.openai.com/v1");
        } finally {
            await gateway.close();
        }
    });
});
