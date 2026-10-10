import {describe, expect, it, vi} from "vitest";
import {CommandReceipts} from "../agent/commandReceipts";
import {createTestAgent, itemStarted, thread, threadResponse, THREAD_ID, turn, turnCompleted, CWD} from "./harness";

async function waitUntil(check: () => boolean): Promise<void> {
    await expect.poll(check, {timeout: 1_000, interval: 5}).toBe(true);
}

async function running(): Promise<ReturnType<typeof createTestAgent>> {
    const t = createTestAgent({cancelGraceMs: 20});
    await t.initialize();
    await t.openSession();
    await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "work"}]});
    await t.settle();
    itemStarted(t.codex, {type: "commandExecution", id: "open-tool", pluginId: null, scriptPath: null, command: "sleep 60", cwd: CWD, processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null});
    return t;
}

describe("cancel recovery", () => {
    it("finishes a cancelled turn when Codex is idle but omits turn/completed", async () => {
        const t = await running();
        t.codex.respond("thread/read", () => ({thread: thread({status: {type: "idle"}})}));
        await t.agent.cancel({sessionId: THREAD_ID});
        await waitUntil(() => t.client.states().at(-1) === "idle");
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "cancelled"});
        expect(t.client.updatesOf("tool_call_update").at(-1)).toMatchObject({toolCallId: "open-tool", status: "cancelled"});
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "next"}]});
        await t.settle();
        expect(t.codex.calls("turn/start")).toHaveLength(2);
        expect(t.codex.calls("turn/steer")).toHaveLength(0);
        turnCompleted(t.codex);
    });

    it("retries an acknowledged interrupt while the thread remains active", async () => {
        const t = await running();
        t.codex.respond("thread/read", () => ({thread: thread({status: {type: "active", activeFlags: []}})}));
        let attempts = 0;
        t.codex.respond("turn/interrupt", () => {
            if (++attempts === 2) setTimeout(() => turnCompleted(t.codex, {status: "interrupted"}), 0);
            return {};
        });
        await t.agent.cancel({sessionId: THREAD_ID});
        await waitUntil(() => t.client.states().at(-1) === "idle");
        expect(attempts).toBe(2);
    });

    it("reports an unconfirmed cancellation without falsely reporting idle and allows another click", async () => {
        const t = await running();
        t.codex.respond("thread/read", () => ({thread: thread({status: {type: "active", activeFlags: []}})}));
        await Promise.all([t.agent.cancel({sessionId: THREAD_ID}), t.agent.cancel({sessionId: THREAD_ID})]);
        await waitUntil(() => t.client.updatesOf("agent_message").length > 0);
        expect(t.client.states()).toEqual(["running"]);
        expect(t.codex.calls("turn/interrupt")).toHaveLength(2);
        expect(t.client.updatesOf("agent_message").at(-1)?.content).toEqual([{type: "text", text: expect.stringContaining("Stop again")}]);
        t.codex.respond("thread/read", () => ({thread: thread({status: {type: "idle"}})}));
        await t.agent.cancel({sessionId: THREAD_ID});
        await waitUntil(() => t.client.states().at(-1) === "idle");
        expect(t.codex.calls("turn/interrupt")).toHaveLength(3);
    });

    it("bounds a hanging interrupt and status query without declaring success", async () => {
        const t = await running();
        t.codex.respond("turn/interrupt", () => new Promise(() => {}));
        t.codex.respond("thread/read", () => new Promise(() => {}));
        await t.agent.cancel({sessionId: THREAD_ID});
        await waitUntil(() => t.client.updatesOf("agent_message").length > 0);
        expect(t.client.states()).toEqual(["running"]);
        expect(t.codex.calls("turn/interrupt")).toHaveLength(2);
        t.codex.respond("turn/interrupt", () => ({}));
        t.codex.respond("thread/read", () => ({thread: thread({status: {type: "idle"}})}));
        await t.agent.cancel({sessionId: THREAD_ID});
        await waitUntil(() => t.client.states().at(-1) === "idle");
        expect(t.codex.calls("turn/interrupt")).toHaveLength(3);
    });

    it("keeps other sessions running while recovering this one", async () => {
        const t = await running();
        t.codex.respond("thread/start", () => threadResponse({id: "other", sessionId: "other"}));
        await t.agent.newSession({cwd: CWD, mcpServers: []});
        await t.agent.prompt({sessionId: "other", prompt: [{type: "text", text: "other work"}]});
        await t.settle();
        t.codex.respond("thread/read", () => ({thread: thread({status: {type: "idle"}})}));
        await t.agent.cancel({sessionId: THREAD_ID});
        await waitUntil(() => t.client.updatesOf("state_update").some(update => update.sessionId === THREAD_ID && update.state === "idle"));
        expect(t.client.updatesOf("state_update").filter(update => update.sessionId === "other").map(update => update.state)).toEqual(["running"]);
        expect(t.codex.calls("turn/interrupt").map(call => call.params)).toEqual([{threadId: THREAD_ID, turnId: "turn-1"}]);
        t.codex.emit({method: "turn/completed", params: {threadId: "other", turn: turn()}});
    });

    it("requires reopening an unloaded conversation instead of sending into a missing native thread", async () => {
        const t = await running();
        t.codex.respond("thread/read", () => ({thread: thread({status: {type: "notLoaded"}})}));
        await t.agent.cancel({sessionId: THREAD_ID});
        await waitUntil(() => t.client.states().at(-1) === "idle");
        expect(t.client.updatesOf("agent_message").at(-1)?.content).toEqual([{type: "text", text: expect.stringContaining("Reopen")}]);
        await expect(t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "next"}]})).rejects.toThrow("resume");
    });

    it("does not interrupt a newer turn when the status query returns late", async () => {
        const t = await running();
        let resolveRead: ((value: {thread: ReturnType<typeof thread>}) => void) | undefined;
        t.codex.respond("thread/read", () => new Promise(resolve => { resolveRead = resolve; }));
        await t.agent.cancel({sessionId: THREAD_ID});
        await waitUntil(() => resolveRead !== undefined);
        turnCompleted(t.codex, {status: "interrupted"});
        await t.settle();
        t.codex.respond("turn/start", () => ({turn: turn({id: "next-turn", status: "inProgress"})}));
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "next"}]});
        await t.settle();
        resolveRead!({thread: thread({status: {type: "idle"}})});
        await t.settle();
        expect(t.client.states()).toEqual(["running", "idle", "running"]);
        expect(t.codex.calls("turn/interrupt")).toHaveLength(1);
        turnCompleted(t.codex, {id: "next-turn"});
    });
});

describe("resumed turn receipt reads", () => {
    it.each(["completion", "idle", "active"])("cancels a stalled restore safely when Codex reports %s", async (nativeState) => {
        const receipts = new CommandReceipts();
        let release!: () => void;
        vi.spyOn(receipts, "read").mockImplementation(async () => {
            await new Promise<void>(resolve => { release = resolve; });
            return {kind: "review", messageId: "original-review", content: [{type: "text", text: "/review"}]};
        });
        const t = createTestAgent({commandReceipts: receipts, cancelGraceMs: 30});
        await t.initialize();
        t.codex.respond("thread/resume", () => threadResponse({status: {type: "active", activeFlags: []}}));
        t.codex.respond("thread/turns/list", () => ({data: [turn({status: "inProgress", items: [
            {type: "userMessage", id: "resumed-user", clientId: null, content: [{type: "text", text: "Native review", text_elements: []}]},
        ]})], nextCursor: null, backwardsCursor: null}));
        await t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD});
        await t.settle();
        t.codex.respond("turn/interrupt", () => {
            if (nativeState === "completion") turnCompleted(t.codex, {status: "interrupted"});
            return {};
        });
        t.codex.respond("thread/read", () => ({thread: thread({status: nativeState === "active" ? {type: "active", activeFlags: []} : {type: "idle"}})}));
        try {
            await t.agent.cancel({sessionId: THREAD_ID});
            if (nativeState === "active") {
                await waitUntil(() => t.client.updatesOf("agent_message").some(update => JSON.stringify(update.content).includes("Stop again")));
                expect(t.client.states()).toEqual(["running"]);
                turnCompleted(t.codex, {status: "interrupted"});
            }
            await waitUntil(() => t.client.states().at(-1) === "idle");
            expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "cancelled"});
            t.codex.respond("turn/start", () => ({turn: turn({id: "next-turn", status: "inProgress"})}));
            const next = await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "next"}]});
            await t.settle();
            const mark = t.client.updates().length;
            release();
            await t.settle();
            expect(t.client.updates()).toHaveLength(mark);
            expect(t.client.updatesOf("user_message")).toMatchObject([{messageId: next.messageId, content: [{type: "text", text: "next"}]}]);
            expect(t.client.states()).toEqual(["running", "idle", "running"]);
        } finally {
            release();
            turnCompleted(t.codex, {status: "interrupted"});
            turnCompleted(t.codex, {id: "next-turn"});
            await t.settle();
        }
    });

    it("bounds restore reads without fabricating message identity or hiding the failure", async () => {
        const receipts = new CommandReceipts();
        vi.spyOn(receipts, "read").mockImplementation(() => new Promise(() => {}));
        const t = createTestAgent({commandReceipts: receipts, cancelGraceMs: 20});
        await t.initialize();
        const native = {type: "userMessage" as const, id: "resumed-user", clientId: null, content: [{type: "text" as const, text: "Native review", text_elements: []}]};
        t.codex.respond("thread/resume", () => threadResponse({status: {type: "active", activeFlags: []}}));
        t.codex.respond("thread/turns/list", () => ({data: [turn({status: "inProgress", items: [native]})], nextCursor: null, backwardsCursor: null}));
        await t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD});
        t.codex.emit({method: "item/agentMessage/delta", params: {threadId: THREAD_ID, turnId: "turn-1", itemId: "progress", delta: "Working"}});
        await waitUntil(() => t.client.updatesOf("agent_message_chunk").some(update => update.messageId === "progress"));
        expect(t.client.states()).toEqual(["running"]);
        itemStarted(t.codex, native);
        turnCompleted(t.codex);
        await waitUntil(() => t.client.states().at(-1) === "idle");
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "error"});
        expect(t.client.updatesOf("user_message")).toHaveLength(0);
        expect(t.client.updatesOf("agent_message_chunk").some(update => JSON.stringify(update.content).includes("history"))).toBe(true);
    });
});
