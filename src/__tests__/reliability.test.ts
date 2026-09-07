import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {describe, expect, it, vi} from "vitest";
import {createTestAgent, CWD, expectRejects, itemCompleted, model, THREAD_ID, threadResponse, turn, turnCompleted} from "./harness";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return {promise, resolve};
}

describe("initialization and validation boundaries", () => {
    it("keeps session methods gated after a failed initialization and allows retry", async () => {
        const t = createTestAgent();
        t.codex.respond("initialize", () => { throw new Error("server not ready"); });
        await expectRejects(t.initialize(), -32603, "server not ready");
        await expectRejects(t.agent.newSession({cwd: CWD}), -32600, "initialize");
        expect(t.codex.calls("thread/start")).toHaveLength(0);
        t.codex.respond("initialize", () => ({}));
        await t.initialize();
        await t.openSession();
    });

    it("shares the upstream handshake between concurrent initialize requests", async () => {
        const t = createTestAgent();
        const ready = deferred<object>();
        t.codex.respond("initialize", () => ready.promise);
        const first = t.initialize();
        const second = t.initialize();
        expect(t.codex.calls("initialize")).toHaveLength(1);
        await expectRejects(t.agent.listSessions({}), -32600, "initialize");
        ready.resolve({});
        await Promise.all([first, second]);
    });

    it("rejects invalid replay cursors before closing a live session", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await expectRejects(t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD,
            replayFrom: {type: "unsupported"} as unknown as NonNullable<acp.ResumeSessionRequest["replayFrom"]>,
        }), -32602, "replayFrom");
        expect(t.codex.calls("thread/unsubscribe")).toHaveLength(0);
        expect(t.codex.calls("thread/resume")).toHaveLength(0);
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/status"}]});
        await t.settle();
        expect(t.client.states()).toEqual(["running", "idle"]);
    });

    it("validates seed history before creating a persistent thread", async () => {
        const t = createTestAgent();
        await t.initialize();
        await expectRejects(t.agent.newSession({cwd: CWD, _meta: {codex: {seedHistory: [{role: "system", text: "bad"}]}}}), -32602, "seedHistory");
        expect(t.codex.calls("thread/start")).toHaveLength(0);
    });

    it("forking a live session preserves its active turn and subscription", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "work"}]});
        await t.settle();
        const fork = await t.agent.forkSession({sessionId: THREAD_ID, cwd: CWD});
        expect(fork.sessionId).toBe("thread-fork");
        expect(t.codex.calls("turn/interrupt")).toHaveLength(0);
        expect(t.codex.calls("thread/unsubscribe")).toHaveLength(0);
        turnCompleted(t.codex);
        await t.settle();
        expect(t.client.updatesOf("state_update").filter(frame => frame.sessionId === THREAD_ID).at(-1)).toMatchObject({state: "idle", stopReason: "end_turn"});
    });

    it("checks image capability when steering as well as starting a turn", async () => {
        const t = createTestAgent({catalog: [model({inputModalities: ["text"]})]});
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "work"}]});
        await t.settle();
        await expectRejects(t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "image", data: "AA==", mimeType: "image/png"}]}), -32602, "image");
        expect(t.codex.calls("turn/steer")).toHaveLength(0);
        turnCompleted(t.codex);
        await t.settle();
    });
});

describe("compaction lifecycle", () => {
    it("cancels compaction without waiting for a completion notification", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/compact"}]});
        await t.settle();
        await t.agent.cancel({sessionId: THREAD_ID});
        await t.settle();
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "cancelled"});
    });

    it("reports a lost connection while waiting for compaction", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/compact"}]});
        await t.settle();
        t.codex.close();
        await t.settle();
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "_error"});
    });
});

describe("close deadlines", () => {
    it("does not lose a completion that arrives before turn/start returns", async () => {
        const t = createTestAgent();
        t.codex.respond("turn/start", () => {
            turnCompleted(t.codex);
            return {turn: turn({status: "inProgress"})};
        });
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "fast"}]});
        await t.settle();
        expect(t.client.states()).toEqual(["running", "idle"]);
    });

    it("accepts the next prompt immediately when idle reaches the client", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        const original = t.client.notify;
        let next: Promise<acp.PromptResponse> | undefined;
        t.client.notify = vi.fn(async (...args: Parameters<typeof original>) => {
            await original(...args);
            const params = args[1] as acp.UpdateSessionNotification;
            if (params.update?.sessionUpdate === "state_update" && params.update.state === "idle" && !next) {
                next = t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "next"}]});
                await next;
            }
        }) as typeof original;
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/status"}]});
        await t.settle();
        expect(next).toBeDefined();
        await expect(next).resolves.toEqual({});
        expect(t.codex.calls("turn/steer")).toHaveLength(0);
        expect(t.client.states()).toEqual(["running", "idle", "running"]);
        turnCompleted(t.codex);
        await t.settle();
    });

    it("closes a session whose turn/start never returns and interrupts a late start exactly once", async () => {
        const t = createTestAgent({closeGraceMs: 10});
        const start = deferred<{turn: ReturnType<typeof turn>}>();
        t.codex.respond("turn/start", () => start.promise);
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "work"}]});
        await t.settle();
        await t.agent.closeSession({sessionId: THREAD_ID});
        expect(t.client.states()).toEqual(["running", "idle"]);
        expect(t.codex.calls("thread/unsubscribe")).toHaveLength(1);
        start.resolve({turn: turn({status: "inProgress"})});
        await t.settle();
        expect(t.codex.calls("turn/interrupt")).toHaveLength(1);
        turnCompleted(t.codex);
        await t.settle();
        expect(t.client.states()).toEqual(["running", "idle"]);
    });

    it("closes even when the interrupt RPC itself never returns", async () => {
        const t = createTestAgent({closeGraceMs: 10});
        t.codex.respond("turn/interrupt", () => new Promise(() => {}));
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "work"}]});
        await t.settle();
        await t.agent.closeSession({sessionId: THREAD_ID});
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "cancelled"});
        expect(t.codex.calls("thread/unsubscribe")).toHaveLength(1);
        t.codex.close();
    });

    it("cancels before turn/start without waiting for a stalled skills refresh", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        const skills = deferred<{data: []}>();
        t.codex.respond("skills/list", () => skills.promise);
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "work"}]});
        await t.settle();
        await t.agent.cancel({sessionId: THREAD_ID});
        await t.settle();
        expect(t.client.states()).toEqual(["running", "idle"]);
        skills.resolve({data: []});
        await t.settle();
        expect(t.codex.calls("turn/start")).toHaveLength(0);
    });

    it("coalesces repeated cancel and close requests into one interrupt", async () => {
        const t = createTestAgent({closeGraceMs: 10});
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "work"}]});
        await t.settle();
        await Promise.all([t.agent.cancel({sessionId: THREAD_ID}), t.agent.cancel({sessionId: THREAD_ID}), t.agent.closeSession({sessionId: THREAD_ID})]);
        expect(t.codex.calls("turn/interrupt")).toHaveLength(1);
        expect(t.client.states()).toEqual(["running", "idle"]);
    });
});

describe("blocking requests across turns", () => {
    it("ends plan approval on disconnect and ignores a late approval", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "collaboration_mode", type: "id", value: "plan"});
        const approval = deferred<acp.RequestPermissionResponse>();
        t.client.permissionResponder = () => approval.promise;
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "plan"}]});
        await t.settle();
        itemCompleted(t.codex, {type: "plan", id: "p", text: "Make a change"});
        turnCompleted(t.codex);
        await t.settle();
        expect(t.client.states().at(-1)).toBe("requires_action");
        t.codex.close();
        await t.settle();
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "_error"});
        approval.resolve({outcome: {outcome: "selected", optionId: "implement_plan"}});
        await t.settle();
        expect(t.codex.calls("turn/start")).toHaveLength(1);
        expect(t.client.states().at(-1)).toBe("idle");
    });

    it("targets the implementation turn when cancellation races its start after plan approval", async () => {
        const t = createTestAgent();
        const implementation = deferred<{turn: ReturnType<typeof turn>}>();
        let starts = 0;
        t.codex.respond("turn/start", () => ++starts === 1 ? {turn: turn({id: "plan-turn", status: "inProgress"})} : implementation.promise);
        await t.initialize();
        await t.openSession();
        await t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "collaboration_mode", type: "id", value: "plan"});
        t.client.permissionResponder = () => ({outcome: {outcome: "selected", optionId: "implement_plan"}});
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "plan"}]});
        await t.settle();
        itemCompleted(t.codex, {type: "plan", id: "p", text: "Make a change"}, "plan-turn");
        turnCompleted(t.codex, {id: "plan-turn"});
        await t.settle();
        expect(starts).toBe(2);
        const cancelled = t.agent.cancel({sessionId: THREAD_ID});
        await t.settle();
        expect(t.codex.calls("turn/interrupt")).toHaveLength(0);
        implementation.resolve({turn: turn({id: "implementation-turn", status: "inProgress"})});
        await cancelled;
        expect(t.codex.lastParams("turn/interrupt")).toEqual({threadId: THREAD_ID, turnId: "implementation-turn"});
        turnCompleted(t.codex, {id: "implementation-turn", status: "interrupted"});
        await t.settle();
        expect(t.client.states().at(-1)).toBe("idle");
    });

    it("keeps interleaved session events and cancellation isolated", async () => {
        const t = createTestAgent();
        let sessions = 0;
        t.codex.respond("thread/start", () => threadResponse({id: `session-${++sessions}`}));
        t.codex.respond("turn/start", ({threadId}) => ({turn: turn({id: `turn-${threadId}`, status: "inProgress"})}));
        await t.initialize();
        const a = await t.openSession();
        const b = await t.openSession();
        await Promise.all([a, b].map(({sessionId}) => t.agent.prompt({sessionId, prompt: [{type: "text", text: "work"}]})));
        await t.settle();
        for (const session of [b, a]) {
            t.codex.emit({method: "item/agentMessage/delta", params: {threadId: session.sessionId, turnId: `turn-${session.sessionId}`, itemId: `message-${session.sessionId}`, delta: session.sessionId}});
        }
        await t.agent.cancel({sessionId: a.sessionId});
        for (const session of [a, b]) {
            t.codex.emit({method: "turn/completed", params: {threadId: session.sessionId, turn: turn({id: `turn-${session.sessionId}`, status: session === a ? "interrupted" : "completed"})}});
        }
        await t.settle();
        expect(t.codex.lastParams("turn/interrupt")).toEqual({threadId: a.sessionId, turnId: `turn-${a.sessionId}`});
        for (const session of [a, b]) {
            const messages = t.client.updatesOf("agent_message_chunk").filter(frame => frame.sessionId === session.sessionId);
            expect(messages.map(frame => frame.content)).toEqual([{type: "text", text: session.sessionId}]);
            const state = t.client.updatesOf("state_update").filter(frame => frame.sessionId === session.sessionId).at(-1);
            expect(state).toMatchObject({state: "idle", stopReason: session === a ? "cancelled" : "end_turn"});
        }
    });

    it("does not let an old approval resolve the next turn's requires_action state", async () => {
        const t = createTestAgent();
        await t.initialize({elicitation: {form: {}}});
        await t.openSession();
        const first = deferred<acp.CreateElicitationResponse>();
        const second = deferred<acp.CreateElicitationResponse>();
        t.client.elicitationResponder = () => first.promise;
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "first"}]});
        await t.settle();
        const params = {threadId: THREAD_ID, turnId: "turn-1", itemId: "question-1", isBlocking: true, questions: []};
        const oldRequest = t.codex.serverRequest("item/tool/requestUserInput", params);
        await t.settle();
        turnCompleted(t.codex);
        await t.settle();
        t.client.elicitationResponder = () => second.promise;
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "second"}]});
        await t.settle();
        const newRequest = t.codex.serverRequest("item/tool/requestUserInput", {...params, itemId: "question-2"});
        await t.settle();
        first.resolve({action: "cancel"});
        await oldRequest;
        expect(t.client.states().at(-1)).toBe("requires_action");
        second.resolve({action: "cancel"});
        await newRequest;
        expect(t.client.states().at(-1)).toBe("running");
        turnCompleted(t.codex);
        await t.settle();
    });
});
