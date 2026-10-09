import {describe, expect, it} from "vitest";
import {parseSessionHistoryParams} from "../agent/sessionHistory";
import type {ThreadTurnsListParams, Turn} from "../app-server/v2";
import {createTestAgent, thread, turn, THREAD_ID, type TestAgent} from "./harness";

function transcript(id: string): Turn {
    return turn({id, startedAt: 100, completedAt: 102, items: [
        {type: "userMessage", id: `${id}-user`, clientId: null, content: [{type: "text", text: "question", text_elements: []}]},
        {type: "agentMessage", id: `${id}-answer`, text: "answer", phase: "final_answer", memoryCitation: null, delivery: null, questions: null},
    ]});
}

async function historyAgent(): Promise<TestAgent & {turns: Turn[]}> {
    const t = createTestAgent();
    await t.initialize();
    const turns = [transcript("one"), transcript("two")];
    t.codex.respond("thread/turns/list", (params: ThreadTurnsListParams) => {
        if (params.sortDirection === "desc") return {data: [turns.at(-1)!], nextCursor: null, backwardsCursor: null};
        return params.cursor ? {data: [turns[1]], nextCursor: null, backwardsCursor: null}
            : {data: [turns[0]], nextCursor: "page-2", backwardsCursor: null};
    });
    t.client.clear();
    return {...t, turns};
}

describe("read-only session history", () => {
    it("reads chronological pages without opening, subscribing or publishing updates", async () => {
        const t = await historyAgent();
        const first = await t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID, limit: 1});
        expect(first).toMatchObject({sessionId: THREAD_ID, complete: false, consistency: "optimistic", turns: [{turnId: "one", startedAt: 100, completedAt: 102}]});
        expect(first.turns[0]?.updates).toEqual([
            expect.objectContaining({sessionUpdate: "user_message", messageId: "one-user", _meta: {codex: {turnId: "one", turnStartedAt: 100000}}}),
            expect.objectContaining({sessionUpdate: "agent_message", messageId: "one-answer", content: [{type: "text", text: "answer"}], _meta: {codex: {phase: "final_answer", turnId: "one", turnStartedAt: 100000}}}),
        ]);
        const second = await t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID, cursor: first.nextCursor!, limit: 1});
        expect(second).toMatchObject({revision: first.revision, complete: true, nextCursor: null, turns: [{turnId: "two"}]});
        expect(t.codex.requests.filter(call => call.method.startsWith("thread/")).every(call => ["thread/read", "thread/turns/list"].includes(call.method))).toBe(true);
        expect(t.client.notifications).toEqual([]);
        await expect(t.agent.prompt({sessionId: THREAD_ID, prompt: []})).rejects.toThrow();
    });

    it("advertises a versioned capability and requires initialization", async () => {
        const t = createTestAgent();
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID})).rejects.toThrow(/initialize/);
        expect((await t.initialize()).capabilities?._meta).toMatchObject({codex: {sessionHistory: {version: 2}}});
    });

    it("rejects a changed history between pages, including same-second tail changes", async () => {
        const t = await historyAgent();
        const first = await t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID});
        t.turns[1] = transcript("replacement");
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID, cursor: first.nextCursor!})).rejects.toThrow(/changed/);
    });

    it("rejects changes during a page and active or incomplete history", async () => {
        const t = await historyAgent();
        let reads = 0;
        t.codex.respond("thread/read", () => ({thread: thread({updatedAt: ++reads})}));
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID})).rejects.toThrow(/changed/);
        t.codex.respond("thread/read", () => ({thread: thread({status: {type: "active", activeFlags: []}})}));
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID})).rejects.toThrow(/running/);
        t.codex.respond("thread/read", () => ({thread: thread()}));
        t.turns[1] = turn({status: "inProgress"});
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID})).rejects.toThrow(/running/);
        t.turns[1] = turn();
        t.turns[0] = turn({itemsView: "summary"});
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID})).rejects.toThrow(/full/);
    });

    it("handles empty history and rejects foreign or malformed cursors", async () => {
        const t = await historyAgent();
        const first = await t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID});
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: "other", cursor: first.nextCursor!})).rejects.toThrow(/cursor/);
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID, cursor: "broken"})).rejects.toThrow(/cursor/);
        t.codex.respond("thread/turns/list", () => ({data: [], nextCursor: null, backwardsCursor: null}));
        expect(await t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID})).toMatchObject({complete: true, nextCursor: null, turns: []});
    });

    it("propagates Codex failures instead of reporting an empty archive", async () => {
        const t = await historyAgent();
        t.codex.respond("thread/read", () => { throw new Error("thread not found"); });
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID})).rejects.toThrow(/thread not found/);
    });

    it("cancels only the read and issues no further requests", async () => {
        const t = await historyAgent();
        const controller = new AbortController();
        t.codex.respond("thread/read", () => new Promise(() => {}));
        const read = t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID}, controller.signal);
        controller.abort();
        await expect(read).rejects.toThrow(/cancelled/);
        expect(t.codex.calls("thread/turns/list")).toHaveLength(0);
        expect(t.codex.calls("turn/interrupt")).toHaveLength(0);
    });
});


describe("history validation and content", () => {
    it.each([null, [], {}, {sessionId: " "}, {sessionId: "s", limit: 0}, {sessionId: "s", limit: 101},
        {sessionId: "s", limit: 1.5}, {sessionId: "s", limit: "1"}, {sessionId: "s", cursor: 1},
        {sessionId: "s", cursor: ""}, {sessionId: "s", cursor: "a".repeat(65537)}])("rejects invalid params %#", raw => {
        expect(() => parseSessionHistoryParams(raw)).toThrow();
    });

    it("preserves terminal output, tool results, failures and reports omitted items", async () => {
        const t = await historyAgent();
        t.turns[0] = turn({id: "one", status: "interrupted", items: [
            {type: "commandExecution", id: "cmd", pluginId: null, scriptPath: null, command: "ls", cwd: "/tmp", processId: null,
                source: "agent", status: "completed", commandActions: [], aggregatedOutput: "a\nb\n", exitCode: 0, durationMs: 3},
            {type: "reasoning", id: "thought", summary: ["thinking"], content: []},
            {type: "enteredReviewMode", id: "review", review: "reviewing"},
        ]});
        const page = await t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID});
        expect(page.turns[0]?.status).toBe("interrupted");
        expect(page.turns[0]?.omissions).toEqual([{itemId: "review", field: "*", reason: "no_acp_representation"}]);
        expect(page.turns[0]?.updates).toEqual(expect.arrayContaining([
            expect.objectContaining({sessionUpdate: "terminal_update", terminalId: "cmd", output: {data: Buffer.from("a\nb\n").toString("base64")}, exitStatus: {exitCode: 0, signal: null}}),
            expect.objectContaining({sessionUpdate: "tool_call_update", toolCallId: "cmd", status: "completed"}),
            expect.objectContaining({sessionUpdate: "agent_thought", messageId: "thought", content: [{type: "text", text: "thinking"}]}),
        ]));
    });

    it("rejects partially loaded interior turns even when the tail is complete", async () => {
        const t = await historyAgent();
        t.turns[0] = turn({itemsView: "notLoaded"});
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID})).rejects.toThrow(/full/);
    });

    it("rejects a native cursor that stops advancing", async () => {
        const t = await historyAgent();
        const first = await t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID});
        t.codex.respond("thread/turns/list", (params: ThreadTurnsListParams) => ({data: [t.turns[1]], nextCursor: params.sortDirection === "asc" ? "page-2" : null, backwardsCursor: null}));
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID, cursor: first.nextCursor!})).rejects.toThrow(/no progress/);
    });

    it("does not detach or interrupt an already open session", async () => {
        const t = await historyAgent();
        await t.openSession();
        await t.settle();
        t.client.clear();
        await t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID});
        expect(t.client.notifications).toEqual([]);
        expect(t.codex.calls("thread/unsubscribe")).toHaveLength(0);
        await expect(t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "continue"}]})).resolves.toMatchObject({messageId: expect.any(String)});
    });

    it("rejects an accepted local prompt before Codex exposes the running turn", async () => {
        const t = await historyAgent();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "pending turn"}]});
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID})).rejects.toThrow(/running/);
        expect(t.codex.calls("turn/interrupt")).toHaveLength(0);
    });

    it("rejects a local prompt accepted while a history page is being read", async () => {
        const t = await historyAgent();
        await t.openSession();
        let reads = 0;
        t.codex.respond("thread/read", async () => {
            if (++reads === 2) await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "pending turn"}]});
            return {thread: thread()};
        });
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID})).rejects.toThrow(/running/);
        expect(t.codex.calls("turn/interrupt")).toHaveLength(0);
    });

    it("does not start an already cancelled read", async () => {
        const t = await historyAgent();
        const controller = new AbortController();
        controller.abort();
        await expect(t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID}, controller.signal)).rejects.toThrow(/cancelled/);
        expect(t.codex.calls("thread/read")).toHaveLength(0);
    });
});
