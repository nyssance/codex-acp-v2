import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {createAgentApp} from "../agent/createAgent";
import {AppServerClient} from "../codex/AppServerClient";
import {describe, expect, it} from "vitest";
import {createTestAgent, CWD, itemCompleted, itemStarted, THREAD_ID, TURN_ID, turnCompleted, turn, threadResponse} from "./harness";
import {ProtocolOracle} from "./protocolOracle";

async function prompting() {
    const t = createTestAgent(); await t.initialize(); await t.openSession();
    await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "work"}]});
    await t.settle(); return t;
}

const command = {type: "commandExecution" as const, id: "shell", pluginId: null, scriptPath: null, command: "echo hello", cwd: CWD, processId: null, source: "agent" as const,
    status: "completed" as const, commandActions: [{type: "unknown" as const, command: "echo hello"}], aggregatedOutput: "hello\n", exitCode: 0, durationMs: 1};

describe("ACP v2 client conformance", () => {
    it("interoperates with the official v2 client over fragmented NDJSON streams", async () => {
        const t = createTestAgent();
        const fragment = () => new TransformStream<Uint8Array, Uint8Array>({transform(bytes, controller) {
            for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
        }});
        const upstream = fragment(), downstream = fragment();
        const server = createAgentApp({codex: new AppServerClient(t.codex.asMessageConnection()), info: {name: "conformance", version: "1"}, env: {}})
            .connect(acp.ndJsonStream(downstream.writable, upstream.readable));
        const oracle = new ProtocolOracle();
        let idle!: () => void;
        const finished = new Promise<void>(resolve => {idle = resolve;});
        const app = acp.client({name: "conformance-client"}).onNotification("session/update", ({params}) => {
            oracle.accept(params.sessionId, params.update);
            if (acp.SessionUpdate.isStateUpdate(params.update) && params.update.state === "idle") idle();
        });
        await app.connectWith(acp.ndJsonStream(upstream.writable, downstream.readable), async client => {
            const init = await client.request("initialize", {protocolVersion: 2, info: {name: "conformance-client", version: "1"}});
            expect(init.protocolVersion).toBe(2);
            const session = await client.request("session/new", {cwd: CWD, mcpServers: []});
            await client.request("session/prompt", {sessionId: session.sessionId, prompt: [{type: "text", text: "你好 🌍"}]});
            await t.settle();
            itemCompleted(t.codex, {type: "agentMessage", id: "unicode", text: "你好 🌍 café", phase: "final_answer", memoryCitation: null, delivery: null, questions: null});
            turnCompleted(t.codex);
            await finished;
            expect(oracle.issues).toEqual([]);
            expect(oracle.messages.get(`${THREAD_ID}:unicode`)).toBe("你好 🌍 café");
            await client.request("session/close", {sessionId: session.sessionId});
        });
        server.close();
        await server.closed;
    });

    it("keeps twenty interleaved sessions isolated through prompt and completion", async () => {
        const t = createTestAgent(); await t.initialize();
        let sequence = 0;
        t.codex.respond("thread/start", () => threadResponse({id: `parallel-${++sequence}`}));
        const sessions = await Promise.all(Array.from({length: 20}, () => t.agent.newSession({cwd: CWD, mcpServers: []})));
        await Promise.all(sessions.map(({sessionId}) => t.agent.prompt({sessionId, prompt: [{type: "text", text: sessionId}]})));
        await t.settle();
        for (let chunk = 0; chunk < 50; chunk++) for (const {sessionId} of sessions) {
            t.codex.emit({method: "item/agentMessage/delta", params: {threadId: sessionId, turnId: TURN_ID, itemId: "answer", delta: `${sessionId} `}});
        }
        for (const {sessionId} of sessions) {
            t.codex.emit({method: "item/completed", params: {threadId: sessionId, turnId: TURN_ID, completedAtMs: 0, item: {type: "agentMessage", id: "answer", text: `${sessionId} `.repeat(50), phase: "final_answer", memoryCitation: null, delivery: null, questions: null}}});
            t.codex.emit({method: "turn/completed", params: {threadId: sessionId, turn: turn()}});
        }
        await t.settle();
        const oracle = new ProtocolOracle();
        for (const update of t.client.updates()) oracle.accept(update.sessionId, update);
        expect(oracle.issues).toEqual([]);
        for (const {sessionId} of sessions) expect(oracle.messages.get(`${sessionId}:answer`)).toBe(`${sessionId} `.repeat(50));
        expect(t.client.states().filter(state => state === "idle")).toHaveLength(20);
    });

    it("reuses model catalogs across opens and invalidates on account updates", async () => {
        const t = createTestAgent(); await t.initialize();
        let count = 0;
        t.codex.respond("thread/start", () => threadResponse({id: `catalog-${++count}`}));
        await t.openSession(); await t.openSession();
        expect(t.codex.calls("model/list")).toHaveLength(1);
        t.codex.emit({method: "account/updated", params: {authMode: "chatgpt", planType: "pro"}}); await t.settle();
        await t.openSession();
        expect(t.codex.calls("model/list")).toHaveLength(2);
    });

    it("returns cancellation promptly and cleans up a session that opens later", async () => {
        const t = createTestAgent({closeGraceMs: 20}); await t.initialize();
        let release!: (value: unknown) => void;
        t.codex.respond("thread/start", () => new Promise(resolve => {release = resolve;}));
        const cancellation = new AbortController();
        const pending = t.agent.newSession({cwd: CWD, mcpServers: []}, cancellation.signal);
        await t.settle();
        cancellation.abort();
        await expect(pending).rejects.toMatchObject({code: -32800});
        release(threadResponse()); await t.settle();
        expect(t.codex.calls("thread/unsubscribe")).toHaveLength(1);
        expect(t.codex.calls("model/list")).toHaveLength(0);
        await expect(t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "orphan?"}]})).rejects.toThrow();
    });

    it("does not resurrect an old tool when its completion arrives during the next turn", async () => {
        const t = await prompting();
        itemStarted(t.codex, {...command, status: "inProgress", aggregatedOutput: null, exitCode: null});
        turnCompleted(t.codex, {status: "interrupted"}); await t.settle();
        t.client.clear();
        t.codex.respond("turn/start", () => ({turn: turn({id: "next-turn", status: "inProgress"})}));
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "next"}]}); await t.settle();
        itemCompleted(t.codex, command, TURN_ID); await t.settle();
        expect(t.client.updatesOf("tool_call_update")).toHaveLength(0);
        turnCompleted(t.codex, {id: "next-turn"}); await t.settle();
    });

    it("uses five cold-open RPCs and one warm-prompt RPC, invalidating skills on change", async () => {
        const t = createTestAgent(); await t.initialize();
        t.codex.requests.length = 0;
        await t.openSession();
        expect(t.codex.requests.map(call => call.method)).toEqual(["account/read", "config/read", "skills/list", "thread/start", "model/list"]);
        t.codex.requests.length = 0;
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "first"}]}); await t.settle();
        expect(t.codex.requests.map(call => call.method)).toEqual(["turn/start"]);
        turnCompleted(t.codex); await t.settle();
        t.codex.emit({method: "skills/changed", params: {}}); await t.settle();
        expect(t.codex.calls("skills/list")).toHaveLength(1);
        expect(t.client.updatesOf("available_commands_update")).toHaveLength(1);
    });

    it("refreshes account-dependent turn settings when Codex changes identity", async () => {
        const t = createTestAgent(); await t.initialize(); await t.openSession();
        t.codex.respond("account/read", () => ({account: {type: "apiKey"}, requiresOpenaiAuth: true}));
        t.codex.emit({method: "account/updated", params: {authMode: "apikey", planType: null}}); await t.settle();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "work"}]}); await t.settle();
        expect(t.codex.lastParams("turn/start")).toMatchObject({summary: "none"});
        turnCompleted(t.codex); await t.settle();
    });

    it("does not switch roots when skills/changed follows the set response", async () => {
        const t = createTestAgent(); await t.initialize();
        let count = 0;
        t.codex.respond("thread/start", () => threadResponse({id: `echo-${++count}`}));
        t.codex.respond("skills/extraRoots/set", () => {
            setTimeout(() => t.codex.emit({method: "skills/changed", params: {}}), 0);
            return {};
        });
        const first = await t.openSession({additionalDirectories: ["/workspace/one"]});
        await t.openSession({additionalDirectories: ["/workspace/two"]});
        const sets = t.codex.calls("skills/extraRoots/set").length;
        t.codex.emit({method: "skills/changed", params: {}}); await t.settle();
        expect(t.codex.calls("skills/extraRoots/set")).toHaveLength(sets);
        await t.agent.prompt({sessionId: first.sessionId, prompt: [{type: "text", text: "work"}]}); await t.settle();
        expect(t.codex.calls("skills/extraRoots/set")).toHaveLength(sets + 1);
        expect(t.client.updatesOf("available_commands_update").some(update => update.sessionId === first.sessionId)).toBe(true);
        t.codex.emit({method: "turn/completed", params: {threadId: first.sessionId, turn: turn()}}); await t.settle();
    });

    it("refreshes an account snapshot changed while session opening was pending", async () => {
        const t = createTestAgent(); await t.initialize();
        let release!: (value: unknown) => void;
        t.codex.respond("thread/start", () => new Promise(resolve => {release = resolve;}));
        const opening = t.agent.newSession({cwd: CWD}); await t.settle();
        t.codex.respond("account/read", () => ({account: {type: "apiKey"}, requiresOpenaiAuth: true}));
        t.codex.emit({method: "account/updated", params: {authMode: "apikey", planType: null}}); await t.settle();
        release(threadResponse()); await opening;
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "work"}]}); await t.settle();
        expect(t.codex.lastParams("turn/start")).toMatchObject({summary: "none"});
        turnCompleted(t.codex); await t.settle();
    });

    it("invalidates model catalogs after local login without an account update", async () => {
        const t = createTestAgent(); await t.initialize();
        let count = 0;
        t.codex.respond("thread/start", () => threadResponse({id: `auth-${++count}`}));
        await t.openSession();
        t.codex.respond("account/login/start", () => {
            t.codex.emit({method: "account/login/completed", params: {loginId: null, success: true, error: null, onboardingEntrypoint: null}});
            return {type: "apiKey"};
        });
        await t.agent.login({methodId: "api-key", _meta: {"api-key": {apiKey: "fixture"}}});
        await t.openSession();
        expect(t.codex.calls("model/list")).toHaveLength(2);
    });

    it("settles a foreign turn started and completed in the same notification burst", async () => {
        const t = createTestAgent(); await t.initialize(); await t.openSession();
        t.codex.emit({method: "turn/started", params: {threadId: THREAD_ID, turn: turn({status: "inProgress"})}});
        turnCompleted(t.codex); await t.settle();
        expect(t.client.states()).toEqual(["running", "idle"]);
        t.client.clear();
        itemCompleted(t.codex, {type: "agentMessage", id: "late", text: "old", phase: null, memoryCitation: null, delivery: null, questions: null});
        await t.settle();
        expect(t.client.updates()).toEqual([]);
    });

    it("does not recursively refresh when Codex echoes skills/changed for extraRoots/set", async () => {
        const t = createTestAgent(); await t.initialize();
        let count = 0;
        t.codex.respond("thread/start", () => threadResponse({id: `roots-${++count}`}));
        let sets = 0;
        t.codex.respond("skills/extraRoots/set", () => {
            if (++sets > 10) throw new Error("recursive refresh");
            t.codex.emit({method: "skills/changed", params: {}});
            return {};
        });
        await t.openSession({additionalDirectories: ["/workspace/one"]});
        await t.openSession({additionalDirectories: ["/workspace/two"]});
        t.codex.emit({method: "skills/changed", params: {}}); await t.settle();
        expect(sets).toBe(2);
        expect(t.codex.calls("skills/list")).toHaveLength(3);
    });

    it("serializes process-global skill roots through turn start without serializing inference", async () => {
        const t = createTestAgent(); await t.initialize();
        let count = 0;
        t.codex.respond("thread/start", () => threadResponse({id: `session-${++count}`}));
        const first = await t.openSession({additionalDirectories: ["/workspace/one"]});
        const second = await t.openSession({additionalDirectories: ["/workspace/two"]});
        let release!: (value: unknown) => void;
        t.codex.respond("turn/start", params => params.threadId === first.sessionId ? new Promise(resolve => {release = resolve;}) : {turn: turn({id: "second", status: "inProgress"})});
        await t.agent.prompt({sessionId: first.sessionId, prompt: [{type: "text", text: "a"}]}); await t.settle();
        const roots = t.codex.calls("skills/extraRoots/set").length;
        await t.agent.prompt({sessionId: second.sessionId, prompt: [{type: "text", text: "b"}]}); await t.settle();
        expect(t.codex.calls("skills/extraRoots/set")).toHaveLength(roots);
        expect(t.codex.calls("turn/start")).toHaveLength(1);
        release({turn: turn({id: "first", status: "inProgress"})}); await t.settle();
        expect(t.codex.calls("turn/start")).toHaveLength(2);
        for (const [sessionId, id] of [[first.sessionId, "first"], [second.sessionId, "second"]] as const) t.codex.emit({method: "turn/completed", params: {threadId: sessionId, turn: turn({id})}});
        await t.settle();
    });

    it("adopts an externally started turn and allows cancellation", async () => {
        const t = createTestAgent(); await t.initialize(); await t.openSession();
        t.codex.emit({method: "turn/started", params: {threadId: THREAD_ID, turn: turn({id: "external", status: "inProgress"})}});
        await t.settle();
        expect(t.client.states()).toEqual(["running"]);
        expect(t.codex.calls("turn/start")).toHaveLength(0);
        await t.agent.cancel({sessionId: THREAD_ID});
        expect(t.codex.lastParams("turn/interrupt")).toEqual({threadId: THREAD_ID, turnId: "external"});
        turnCompleted(t.codex, {id: "external", status: "interrupted"}); await t.settle();
        expect(t.client.states()).toEqual(["running", "idle"]);
    });

    it("settles a resumed turn that completes while its active snapshot is being read", async () => {
        const t = createTestAgent(); await t.initialize();
        t.codex.respond("thread/resume", () => threadResponse({status: {type: "active", activeFlags: []}}));
        t.codex.respond("thread/turns/list", params => {
            if (params.sortDirection === "desc") turnCompleted(t.codex, {id: "resumed-turn", status: "interrupted"});
            return {data: [turn({id: "resumed-turn", status: "inProgress", items: [{...command, status: "inProgress", exitCode: null}]})], nextCursor: null};
        });
        await t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD}); await t.settle();
        const oracle = new ProtocolOracle();
        for (const update of t.client.updates()) oracle.accept(update.sessionId, update);
        expect(oracle.issues).toEqual([]);
        expect(t.client.states()).toEqual(["running", "idle"]);
        expect(t.client.updatesOf("tool_call_update").at(-1)).toMatchObject({status: "cancelled"});
    });

    it("restores running state when resuming an active thread without turn history", async () => {
        const t = createTestAgent(); await t.initialize();
        t.codex.respond("thread/resume", () => threadResponse({status: {type: "active", activeFlags: []}}));
        t.codex.respond("thread/turns/list", () => ({data: [turn({id: "resumed-turn", status: "inProgress"})], nextCursor: null}));
        await t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD});
        expect(t.client.states()).toContain("running");
        turnCompleted(t.codex, {id: "resumed-turn"}); await t.settle();
        expect(t.client.states().at(-1)).toBe("idle");
    });

    it("keeps a complete terminal snapshot while bounding duplicate tool output", async () => {
        const t = await prompting();
        const output = "🌍".repeat(50_000);
        itemCompleted(t.codex, {...command, aggregatedOutput: output});
        turnCompleted(t.codex); await t.settle();
        const tool = t.client.updatesOf("tool_call_update").at(-1)!;
        expect((tool.rawOutput as {output: string}).output.length).toBeLessThanOrEqual(16_384);
        expect(tool._meta).toMatchObject({codex: {outputTruncated: true}});
        const terminal = t.client.updatesOf("terminal_update").at(-1)!;
        expect(Buffer.from(terminal.output!.data, "base64").toString()).toBe(output);
    });

    it.each([
        {info: "contextWindowExceeded", reason: "max_tokens", category: "context_window", retryable: false},
        {info: "misalignmentPolicyViolation", reason: "refusal", category: "policy", retryable: false},
        {info: "rateLimitExceeded", reason: "_error", category: "rate_limit", retryable: true},
    ] as const)("maps $info to standard stop semantics", async ({info, reason, category, retryable}) => {
        const t = await prompting();
        turnCompleted(t.codex, {status: "failed", error: {message: "Cannot continue", codexErrorInfo: info, additionalDetails: null, misalignment: null}});
        await t.settle();
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: reason, _meta: {codex: {error: {category, retryable}}}});
    });

    it.each(["completed", "interrupted", "failed"] as const)("finalizes orphan tools and terminals on %s before idle", async status => {
        const t = await prompting();
        itemStarted(t.codex, {...command, status: "inProgress", aggregatedOutput: null, exitCode: null});
        turnCompleted(t.codex, {status}); await t.settle();
        const client = new ProtocolOracle();
        for (const update of t.client.updates()) client.accept(update.sessionId, update);
        expect(client.issues).toEqual([]);
        expect(t.client.updatesOf("tool_call_update").at(-1)).toMatchObject({status: status === "interrupted" ? "cancelled" : status, _meta: {codex: {reconciled: true}}});
        expect(t.client.updatesOf("terminal_update").at(-1)).toMatchObject({exitStatus: {exitCode: null, signal: null}});
    });

    it("starts a new turn when a rejected steer races a matching turn completion", async () => {
        const t = await prompting();
        t.codex.respond("turn/steer", () => {turnCompleted(t.codex); throw new Error("turn already ended");});
        await expect(t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "next"}]})).resolves.toEqual({});
        await t.settle();
        expect(t.codex.calls("turn/start")).toHaveLength(2);
        turnCompleted(t.codex); await t.settle();
    });

    it.each([{deltas: []}, {deltas: ["partial"]}, {deltas: ["hello ", "world"]}])("converges message snapshots after deltas $deltas", async ({deltas}) => {
        const t = await prompting();
        for (const delta of deltas) t.codex.emit({method: "item/agentMessage/delta", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "answer", delta}});
        itemCompleted(t.codex, {type: "agentMessage", id: "answer", text: "hello world", phase: "final_answer", memoryCitation: null, delivery: null, questions: null});
        turnCompleted(t.codex); await t.settle();
        const client = new ProtocolOracle();
        for (const update of t.client.updates()) client.accept(update.sessionId, update);
        expect(client.issues).toEqual([]);
        expect(client.messages.get(`${THREAD_ID}:answer`)).toBe("hello world");
    });

    it("creates complete first tool upserts when start events were missed", async () => {
        const t = await prompting();
        itemCompleted(t.codex, command);
        itemCompleted(t.codex, {type: "fileChange", id: "file", changes: [{path: `${CWD}/a.txt`, kind: {type: "add"}, diff: "a\n"}], status: "completed"});
        itemCompleted(t.codex, {type: "mcpToolCall", id: "mcp", server: "docs", tool: "read", status: "completed", arguments: {}, appContext: null, pluginId: null, readOnlyHint: true, result: {content: [], structuredContent: null, _meta: null}, error: null, durationMs: 1});
        turnCompleted(t.codex); await t.settle();
        const client = new ProtocolOracle();
        for (const update of t.client.updates()) client.accept(update.sessionId, update);
        expect(client.issues).toEqual([]);
        expect(t.client.updatesOf("terminal_update")[0]).toMatchObject({command: "echo hello", output: {data: Buffer.from("hello\n").toString("base64")}, exitStatus: {exitCode: 0}});
    });

    it("creates valid upserts for progress and patch events arriving first", async () => {
        const t = await prompting();
        t.codex.emit({method: "item/mcpToolCall/progress", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "mcp", message: "Working"}});
        t.codex.emit({method: "item/fileChange/patchUpdated", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "file", changes: [{path: `${CWD}/x`, kind: {type: "add"}, diff: "x"}]}});
        turnCompleted(t.codex); await t.settle();
        const client = new ProtocolOracle();
        for (const update of t.client.updates()) client.accept(update.sessionId, update);
        expect(client.issues).toEqual([]);
    });

    it("does not route late output from an interrupted terminal into the next turn", async () => {
        const t = await prompting();
        itemStarted(t.codex, {...command, status: "inProgress", aggregatedOutput: null, exitCode: null});
        turnCompleted(t.codex, {status: "interrupted"}); await t.settle();
        t.client.clear();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "next"}]}); await t.settle();
        t.codex.emit({method: "item/commandExecution/outputDelta", params: {threadId: THREAD_ID, turnId: "old-turn", itemId: "shell", delta: "stale"}});
        turnCompleted(t.codex); await t.settle();
        expect(t.client.updatesOf("terminal_output_chunk")).toHaveLength(0);
    });
    it.each(["model/list", "thread/turns/list"])("bounds cyclic %s pagination and failed-open cleanup", async (method) => {
        const t = createTestAgent({closeGraceMs: 20});
        await t.initialize();
        let pages = 0;
        t.codex.respond(method, () => {
            if (++pages > 4) throw new Error("pagination did not stop");
            return {data: [], nextCursor: pages % 2 ? "a" : "b", backwardsCursor: null};
        });
        let release!: (value: unknown) => void;
        t.codex.respond("thread/unsubscribe", () => new Promise(resolve => {release = resolve;}));
        await expect(t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD, replayFrom: {type: "start"}})).rejects.toThrow(/pagination.*cursor/);
        expect(pages).toBe(3);
        await expect(t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD})).rejects.toThrow("unsubscribe is still pending");
        expect(t.codex.calls("thread/resume")).toHaveLength(1);
        release({}); await t.settle();
        t.codex.respond(method, () => ({data: [], nextCursor: null, backwardsCursor: null}));
        await expect(t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD})).resolves.toMatchObject({});
    });

});
