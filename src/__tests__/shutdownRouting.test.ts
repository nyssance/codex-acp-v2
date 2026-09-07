import {describe, it, expect} from "vitest";
import {PassThrough, Writable} from "node:stream";
import {createCodexConnection} from "../codex/transport";
import {AppServerClient} from "../codex/AppServerClient";
import {createTestAgent, THREAD_ID, CWD, threadResponse, turnCompleted} from "./harness";

describe("shutdown and routing regressions", () => {
    it.each([0, 2, 20])("delivers a response behind %i notifications immediately before EOF", async notifications => {
        const incoming = new PassThrough();
        const seen: number[] = [];
        const outgoing = new Writable({write(chunk, _encoding, done) {
            const frame = JSON.parse(chunk.toString());
            const frames = Array.from({length: notifications}, (_, index) => JSON.stringify({method: "notice", params: {index}}));
            frames.push(JSON.stringify({id: frame.id, result: {data: [], nextCursor: null, backwardsCursor: null}}));
            setImmediate(() => incoming.end(frames.join("\n") + "\n"));
            done();
        }});
        const {connection} = createCodexConnection(incoming, outgoing);
        const codex = new AppServerClient(connection);
        connection.onNotification("notice", params => { seen.push(params.index); });
        connection.listen();
        try {
            await expect(codex.threadList({})).resolves.toMatchObject({data: []});
            expect(seen).toEqual(Array.from({length: notifications}, (_, index) => index));
        } finally { connection.dispose(); outgoing.destroy(); }
    });

    it("closes an idle session when unsubscribe never responds", async () => {
        const t = createTestAgent({closeGraceMs: 10});
        await t.initialize(); await t.openSession();
        t.codex.respond("thread/unsubscribe", () => new Promise(() => {}));
        const result = await t.agent.closeSession({sessionId: THREAD_ID});
        expect(result).toMatchObject({_meta: {codex: {close: {remoteUnsubscribe: "timed_out"}}}});
        t.codex.close();
    });

    it("includes a stalled notification drain in the close budget", async () => {
        const t = createTestAgent({closeGraceMs: 10});
        await t.initialize(); await t.openSession();
        const original = t.client.notify;
        const hold = deferred<void>();
        t.client.notify = (async (method: string, params?: any) => {
            await original(method, params);
            if (params?.update?.sessionUpdate === "agent_message_chunk") await hold.promise;
        }) as typeof original;
        await t.agent.prompt({...prompt, prompt: [...prompt.prompt]});
        await t.settle();
        t.codex.emit({method: "item/agentMessage/delta", params: {threadId: THREAD_ID, turnId: "turn-1", itemId: "m", delta: "text"}});
        turnCompleted(t.codex);
        await t.settle();
        await t.agent.closeSession({sessionId: THREAD_ID});
        const states = t.client.states();
        hold.resolve(); await t.settle();
        expect(t.client.states()).toEqual(states);
        expect(states.filter(state => state === "idle")).toHaveLength(1);
    });

    it("does not publish routing when its rebind failed", async () => {
        const t = createTestAgent(); await t.initialize(); await t.openSession();
        const before = t.agent.listProviders({});
        t.codex.respond("thread/resume", () => { throw new Error("rebind failed"); });
        await expect(t.agent.setProvider(gateway)).rejects.toThrow("rebind failed");
        expect(t.agent.listProviders({})).toEqual(before);
    });

    it("retries a rejected interrupt on the next cancel and retains a successful acknowledgement", async () => {
        const t = createTestAgent({closeGraceMs: 10}); await t.initialize(); await t.openSession();
        let attempts = 0;
        t.codex.respond("turn/interrupt", () => {
            if (++attempts === 1) throw new Error("temporary rejection");
            return {};
        });
        await t.agent.prompt({...prompt, prompt: [...prompt.prompt]}); await t.settle();
        await t.agent.cancel({sessionId: THREAD_ID});
        await t.agent.cancel({sessionId: THREAD_ID});
        await t.agent.cancel({sessionId: THREAD_ID});
        await t.agent.closeSession({sessionId: THREAD_ID});
        expect(attempts).toBe(2);
    });
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

const gateway = {providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"} as const;
const prompt = {sessionId: THREAD_ID, prompt: [{type: "text", text: "work"}]} as const;


describe("provider transactions", () => {
    it("compensates every attempted session including the failed request and preserves MCP config", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.agent.newSession({cwd: CWD, mcpServers: [{type: "stdio", name: "client", command: "test-mcp", args: [], env: []}]});
        t.codex.respond("thread/start", () => threadResponse({id: "thread-2"}));
        await t.agent.newSession({cwd: CWD});
        const before = t.agent.listProviders({});
        let count = 0;
        t.codex.respond("thread/resume", params => {
            if (++count === 2) throw new Error("second failed after mutation");
            return threadResponse({id: params.threadId});
        });
        await expect(t.agent.setProvider(gateway)).rejects.toThrow("second failed");
        expect(t.agent.listProviders({})).toEqual(before);
        const calls = t.codex.calls("thread/resume").map(call => call.params as any);
        expect(calls.map(call => call.threadId)).toEqual([THREAD_ID, "thread-2", THREAD_ID, "thread-2"]);
        expect(calls[0].config.mcp_servers.client.command).toBe("test-mcp");
        expect(calls[2].config.mcp_servers.client.command).toBe("test-mcp");
        await t.agent.prompt({...prompt, prompt: [...prompt.prompt]});
        await t.settle();
        turnCompleted(t.codex);
        await t.settle();
    });

    it("marks uncertain routing stale and recovers it with a successful switch", async () => {
        const t = createTestAgent();
        await t.initialize(); await t.openSession();
        t.codex.respond("thread/resume", () => { throw new Error("offline"); });
        await expect(t.agent.setProvider(gateway)).rejects.toMatchObject({data: {staleSessions: [THREAD_ID]}});
        await expect(t.agent.prompt({...prompt, prompt: [...prompt.prompt]})).rejects.toThrow("stale");
        expect(t.client.updatesOf("config_option_update").at(-1)).toMatchObject({_meta: {codex: {routing: {stale: true}}}});
        t.codex.respond("thread/resume", () => threadResponse());
        await t.agent.setProvider(gateway);
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/status"}]});
        await t.settle();
        expect(t.client.states().at(-1)).toBe("idle");
    });

    it("guards admission and serializes competing switches", async () => {
        const t = createTestAgent(); await t.initialize(); await t.openSession();
        const hold = deferred<ReturnType<typeof threadResponse>>();
        let calls = 0;
        t.codex.respond("thread/resume", () => ++calls === 1 ? hold.promise : threadResponse());
        const first = t.agent.setProvider(gateway);
        await t.settle();
        const second = t.agent.setProvider({...gateway, baseUrl: "https://second.example/v1"});
        for (const operation of [
            () => t.agent.prompt({...prompt, prompt: [...prompt.prompt]}),
            () => t.agent.newSession({cwd: CWD}),
            () => t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD}),
            () => t.agent.forkSession({sessionId: THREAD_ID, cwd: CWD}),
            () => t.agent.closeSession({sessionId: THREAD_ID}),
            () => t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "model", type: "id", value: "gpt-5"}),
        ]) await expect(operation()).rejects.toThrow("routing is changing");
        expect(calls).toBe(1);
        hold.resolve(threadResponse());
        await Promise.all([first, second]);
        expect(calls).toBe(2);
        expect(t.agent.listProviders({}).providers[0]?.current?.baseUrl).toBe("https://second.example/v1");
    });

    it("does not change routing during an admitted lifecycle operation or an active turn", async () => {
        const t = createTestAgent(); await t.initialize();
        const hold = deferred<ReturnType<typeof threadResponse>>();
        t.codex.respond("thread/start", () => hold.promise);
        const opening = t.agent.newSession({cwd: CWD});
        await t.settle();
        await expect(t.agent.setProvider(gateway)).rejects.toThrow("lifecycle work");
        hold.resolve(threadResponse()); await opening;
        await t.agent.prompt({...prompt, prompt: [...prompt.prompt]});
        await expect(t.agent.setProvider(gateway)).rejects.toThrow("turn is running");
        await t.settle(); turnCompleted(t.codex); await t.settle();
    });
});

describe("bounded local close", () => {
    it("uses one total budget and observes a late unsubscribe rejection", async () => {
        const t = createTestAgent({closeGraceMs: 40}); await t.initialize(); await t.openSession();
        const unsubscribe = deferred<object>();
        t.codex.respond("thread/unsubscribe", () => unsubscribe.promise);
        t.codex.respond("turn/interrupt", () => new Promise(() => {}));
        await t.agent.prompt({...prompt, prompt: [...prompt.prompt]}); await t.settle();
        const start = performance.now();
        const result = await t.agent.closeSession({sessionId: THREAD_ID});
        expect(performance.now() - start).toBeLessThan(100);
        expect(result).toMatchObject({_meta: {codex: {close: {localDetached: true, attempted: true, remoteUnsubscribe: "timed_out"}}}});
        unsubscribe.reject(new Error("late failure"));
        await t.settle();
        await expect(t.agent.prompt({...prompt, prompt: [...prompt.prompt]})).rejects.toThrow("Unknown session");
    });

    it("releases a stalled idle write without sending duplicate terminal frames", async () => {
        const t = createTestAgent({closeGraceMs: 10}); await t.initialize(); await t.openSession();
        const hold = deferred<void>();
        const original = t.client.notify;
        t.client.notify = (async (method: string, params?: any) => {
            await original(method, params);
            if (params?.update?.state === "idle") await hold.promise;
        }) as typeof original;
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/status"}]});
        await t.settle();
        await t.agent.closeSession({sessionId: THREAD_ID});
        hold.resolve(); await t.settle();
        expect(t.client.states().filter(state => state === "idle")).toHaveLength(1);
    });

    it("retries a rejected interrupt on close but coalesces in-flight and successful cancels", async () => {
        const t = createTestAgent({closeGraceMs: 10}); await t.initialize(); await t.openSession();
        const hold = deferred<object>();
        let count = 0;
        t.codex.respond("turn/interrupt", () => ++count === 1 ? hold.promise : {});
        await t.agent.prompt({...prompt, prompt: [...prompt.prompt]}); await t.settle();
        const first = t.agent.cancel({sessionId: THREAD_ID});
        const second = t.agent.cancel({sessionId: THREAD_ID});
        expect(count).toBe(1);
        hold.reject(new Error("retry me")); await Promise.all([first, second]);
        await t.agent.closeSession({sessionId: THREAD_ID});
        expect(count).toBe(2);
    });

    it("preserves a dispatched completion when the connection immediately closes", async () => {
        const t = createTestAgent(); await t.initialize(); await t.openSession();
        await t.agent.prompt({...prompt, prompt: [...prompt.prompt]}); await t.settle();
        turnCompleted(t.codex); t.codex.close(); await t.settle();
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "end_turn"});
    });
});

describe("late writes across turn generations", () => {
    it("does not let a rejected old idle overwrite a newly admitted turn", async () => {
        const t = createTestAgent(); await t.initialize(); await t.openSession();
        const idle = deferred<void>();
        const original = t.client.notify;
        let firstIdle = true;
        t.client.notify = (async (method: string, params?: any) => {
            await original(method, params);
            if (params?.update?.state === "idle" && firstIdle) {
                firstIdle = false;
                await idle.promise;
            }
        }) as typeof original;
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/status"}]});
        await t.settle();
        await t.agent.prompt({...prompt, prompt: [...prompt.prompt]}); await t.settle();
        idle.reject(new Error("old write failed")); await t.settle();
        expect(t.client.states()).toEqual(["running", "idle", "running"]);
        turnCompleted(t.codex); await t.settle();
        expect(t.client.states()).toEqual(["running", "idle", "running", "idle"]);
    });

    it("blocks overlapping resume while close still owns the old subscription", async () => {
        const t = createTestAgent({closeGraceMs: 100}); await t.initialize(); await t.openSession();
        const unsubscribe = deferred<object>();
        t.codex.respond("thread/unsubscribe", () => unsubscribe.promise);
        const closing = t.agent.closeSession({sessionId: THREAD_ID});
        await expect(t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD})).rejects.toThrow("lifecycle");
        await expect(t.agent.closeSession({sessionId: THREAD_ID})).rejects.toThrow("lifecycle");
        unsubscribe.resolve({}); await closing;
        await expect(t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD})).resolves.toBeDefined();
    });
});

describe("approval teardown", () => {
    it("fails an idle session's pending approval closed on local disposal", async () => {
        const t = createTestAgent({closeGraceMs: 10}); await t.initialize(); await t.openSession();
        t.client.permissionResponder = () => new Promise(() => {});
        const pending = t.codex.serverRequest("item/fileChange/requestApproval", {threadId: THREAD_ID, turnId: "turn-1", itemId: "file-1", startedAtMs: 0});
        await t.settle();
        expect(t.client.permissionRequests()).toHaveLength(1);
        await t.agent.closeSession({sessionId: THREAD_ID});
        await expect(pending).resolves.toEqual({decision: "cancel"});
    });

    it("fails closed on disconnect even if requires_action output is stalled", async () => {
        const t = createTestAgent({closeGraceMs: 10}); await t.initialize(); await t.openSession();
        await t.agent.prompt({...prompt, prompt: [...prompt.prompt]}); await t.settle();
        const original = t.client.notify;
        const hold = deferred<void>();
        t.client.notify = (async (method: string, params?: any) => {
            await original(method, params);
            if (params?.update?.state === "requires_action") await hold.promise;
        }) as typeof original;
        const pending = t.codex.serverRequest("item/fileChange/requestApproval", {threadId: THREAD_ID, turnId: "turn-1", itemId: "file-1", startedAtMs: 0});
        await t.settle();
        t.codex.close();
        await expect(pending).resolves.toEqual({decision: "cancel"});
        hold.resolve(); await t.settle();
        expect(t.client.permissionRequests()).toHaveLength(0);
        await t.agent.closeSession({sessionId: THREAD_ID});
    });
});

describe("late remote unsubscribe", () => {
    it.each(["resolve", "reject"] as const)("fences resume until a timed-out unsubscribe settles by %s", async outcome => {
        const t = createTestAgent({closeGraceMs: 10}); await t.initialize(); await t.openSession();
        const hold = deferred<object>();
        t.codex.respond("thread/unsubscribe", () => hold.promise);
        await t.agent.closeSession({sessionId: THREAD_ID});
        await expect(t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD})).rejects.toThrow("unsubscribe is still pending");
        await expect(t.agent.forkSession({sessionId: THREAD_ID, cwd: CWD})).rejects.toThrow("unsubscribe is still pending");
        if (outcome === "resolve") hold.resolve({});
        else hold.reject(new Error("late unsubscribe failure"));
        await t.settle();
        await expect(t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD})).resolves.toBeDefined();
    });
});

describe("routing reload preflight", () => {
    it("checks every history before unsubscribing any session", async () => {
        const t = createTestAgent(); await t.initialize(); await t.openSession();
        t.codex.respond("thread/start", () => threadResponse({id: "empty-thread"}));
        await t.agent.newSession({cwd: CWD});
        const before = t.agent.listProviders({});
        t.codex.respond("thread/turns/list", params => {
            if (params.threadId === "empty-thread") throw new Error("no rollout found");
            return {data: [], nextCursor: null, backwardsCursor: null};
        });
        await expect(t.agent.setProvider(gateway)).rejects.toMatchObject({code: -32600, data: {sessionId: "empty-thread"}});
        expect(t.codex.calls("thread/unsubscribe")).toHaveLength(0);
        expect(t.codex.calls("thread/resume")).toHaveLength(0);
        expect(t.agent.listProviders({})).toEqual(before);
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/status"}]});
        await t.settle();
        expect(t.client.states().at(-1)).toBe("idle");
    });
});

describe("replacement-session unsubscribe fence", () => {
    it("rechecks the fence after an inline close times out", async () => {
        const t = createTestAgent({closeGraceMs: 10}); await t.initialize(); await t.openSession();
        const hold = deferred<object>();
        t.codex.respond("thread/unsubscribe", () => hold.promise);
        await expect(t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD})).rejects.toThrow("unsubscribe is still pending");
        expect(t.codex.calls("thread/resume")).toHaveLength(0);
        hold.resolve({}); await t.settle();
        await expect(t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD})).resolves.toBeDefined();
        expect(t.codex.calls("thread/resume")).toHaveLength(1);
    });
});
