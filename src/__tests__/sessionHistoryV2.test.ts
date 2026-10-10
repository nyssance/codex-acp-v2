import {describe, expect, it, vi} from "vitest";
import {parseSessionHistoryParams, parseSessionHistoryItemsParams} from "../agent/historyProtocol";
import {ResponseError} from "vscode-jsonrpc/node";
import {CommandReceipts} from "../agent/commandReceipts";
import type {ThreadItem, ThreadTurnsListParams} from "../app-server/v2";
import {createTestAgent, thread, turn, THREAD_ID, type TestAgent} from "./harness";

const mixed: ThreadItem = {type: "userMessage", id: "mixed", clientId: null, content: [
    {type: "text", text: "Listen", text_elements: []},
    {type: "audio", url: "https://example.test/a.wav"},
    {type: "localImage", path: process.platform === "win32" ? "C:\\tmp\\image.png" : "/tmp/image.png"},
]};

async function setup(): Promise<TestAgent> {
    const t = createTestAgent();
    await t.initialize();
    t.codex.respond("thread/turns/list", (p: ThreadTurnsListParams) => ({
        data: [turn({id: "t1", itemsView: p.itemsView ?? "summary", items: p.itemsView === "full" ? [mixed] : []})],
        nextCursor: null, backwardsCursor: null,
    }));
    t.codex.respond("thread/items/list", () => ({
        data: [{turnId: "t1", item: mixed, startedAtMs: 10, completedAtMs: 20}], nextCursor: null, backwardsCursor: null,
    }));
    return t;
}

describe("general-purpose read-only history", () => {
    it.each(["turns", "items"])("cancels %s history while receipt reads are pending", async (endpoint) => {
        const commandReceipts = new CommandReceipts();
        let rejectRead!: (reason: Error) => void;
        let started!: () => void;
        const reading = new Promise<void>(resolve => { started = resolve; });
        vi.spyOn(commandReceipts, "read").mockImplementation(() => new Promise((_, reject) => {
            rejectRead = reject;
            started();
        }));
        const t = createTestAgent({commandReceipts});
        await t.initialize();
        t.codex.respond("thread/turns/list", () => ({data: [turn({itemsView: "full", items: [mixed]})], nextCursor: null, backwardsCursor: null}));
        t.codex.respond("thread/items/list", () => ({data: [{turnId: "t1", item: mixed, startedAtMs: null, completedAtMs: null}], nextCursor: null, backwardsCursor: null}));
        const controller = new AbortController();
        const request = endpoint === "turns"
            ? t.agent.sessionHistory({sessionId: THREAD_ID, itemsView: "full"}, controller.signal)
            : t.agent.sessionHistoryItems({sessionId: THREAD_ID}, controller.signal);
        const outcome = request.then(() => ({status: "success"}), (error: unknown) => ({status: "error", error}));
        let result: unknown;
        void outcome.then(value => { result = value; });
        await reading;
        controller.abort();
        try {
            await expect.poll(() => result, {timeout: 500}).toMatchObject({status: "error", error: {data: {reason: "history_cancelled"}}});
        } finally {
            rejectRead(new Error("late read failure"));
            await outcome;
        }
    });

    it("projects retained commands under their original receipt in both history APIs", async () => {
        const commandReceipts = new CommandReceipts();
        await commandReceipts.write("review-native", {kind: "review", messageId: "review-receipt", content: [{type: "text", text: "/review"}]});
        const t = createTestAgent({commandReceipts});
        await t.initialize();
        const native: ThreadItem = {type: "userMessage", id: "review-native", clientId: null, content: [{type: "text", text: "Review the current code changes", text_elements: []}]};
        t.codex.respond("thread/turns/list", () => ({data: [turn({id: "review-turn", itemsView: "full", items: [native]})], nextCursor: null, backwardsCursor: null}));
        t.codex.respond("thread/items/list", () => ({data: [{turnId: "review-turn", item: native, startedAtMs: null, completedAtMs: null}], nextCursor: null, backwardsCursor: null}));
        const page = await t.agent.sessionHistory({sessionId: THREAD_ID, itemsView: "full"});
        expect(page.turns[0]?.updates).toMatchObject([{sessionUpdate: "user_message", messageId: "review-receipt", content: [{type: "text", text: "/review"}]}]);
        const items = await t.agent.sessionHistoryItems({sessionId: THREAD_ID});
        expect(items.items[0]?.updates).toMatchObject([{sessionUpdate: "user_message", messageId: "review-receipt", content: [{type: "text", text: "/review"}]}]);
    });

    it("preserves mixed media as typed resource references without silent losses", async () => {
        const t = await setup();
        const page = await t.agent.sessionHistory({sessionId: THREAD_ID, itemsView: "full", includeNative: true});
        expect(page.turns[0]?.updates).toEqual([expect.objectContaining({sessionUpdate: "user_message", content: [
            expect.objectContaining({type: "text", text: "Listen"}),
            expect.objectContaining({type: "resource_link", uri: "https://example.test/a.wav", _meta: {codex: {inputType: "audio"}}}),
            expect.objectContaining({type: "resource_link", uri: process.platform === "win32" ? "file:///C:/tmp/image.png" : "file:///tmp/image.png", _meta: {codex: {inputType: "localImage"}}}),
        ]})]);
        expect(page.turns[0]?._meta?.codex.items).toEqual([mixed]);
        expect(page.turns[0]?.omissions).toEqual([]);
    });

    it("browses running sessions and defaults to lightweight summaries", async () => {
        const t = await setup();
        t.codex.respond("thread/read", () => ({thread: thread({status: {type: "active", activeFlags: []}})}));
        const page = await t.agent.sessionHistory({sessionId: THREAD_ID, sortDirection: "desc"});
        expect(page).toMatchObject({running: true, consistency: "live", revision: null});
        expect(page.turns[0]).toMatchObject({itemsView: "summary", updates: []});
        expect(t.codex.calls("thread/turns/list")).toHaveLength(1);
        expect(t.codex.lastParams("thread/turns/list")).toMatchObject({sortDirection: "desc", itemsView: "summary"});
        expect(t.codex.calls("thread/read")).toHaveLength(1);
        expect(t.client.updates()).toEqual([]);
    });

    it("does not report a foreign unloaded thread as definitely idle", async () => {
        const t = await setup();
        t.codex.respond("thread/read", () => ({thread: thread({status: {type: "notLoaded"}})}));
        expect((await t.agent.sessionHistory({sessionId: THREAD_ID})).running).toBeNull();
        expect((await t.agent.sessionHistoryItems({sessionId: THREAD_ID})).running).toBeNull();
    });

    it("keeps export strict and uses summary boundaries instead of reloading the full tail", async () => {
        const t = await setup();
        await t.agent.sessionHistory({sessionId: THREAD_ID, mode: "export", itemsView: "full"});
        const calls = t.codex.calls("thread/turns/list").map(call => call.params as ThreadTurnsListParams);
        expect(calls.filter(p => p.sortDirection === "desc").every(p => p.itemsView === "summary")).toBe(true);
        t.codex.respond("thread/read", () => ({thread: thread({status: {type: "active", activeFlags: []}})}));
        await expect(t.agent.sessionHistory({sessionId: THREAD_ID, mode: "export"})).rejects.toMatchObject({data: {reason: "history_busy", retryable: true}});
    });

    it("allows accepted local prompts in browse mode but not export mode", async () => {
        const t = await setup();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "go"}]});
        expect((await t.agent.sessionHistory({sessionId: THREAD_ID})).running).toBe(true);
        await expect(t.agent.sessionHistory({sessionId: THREAD_ID, mode: "export"})).rejects.toMatchObject({data: {reason: "history_busy"}});
    });

    it("loads items in a chosen turn after an item anchor and binds the continuation to its options", async () => {
        const t = await setup();
        t.codex.respond("thread/items/list", () => ({data: [{turnId: "t1", item: mixed, startedAtMs: 10, completedAtMs: 20}], nextCursor: "items-next", backwardsCursor: null}));
        const first = await t.agent.sessionHistoryItems({sessionId: THREAD_ID, turnId: "t1", anchorItemId: "before", limit: 1, sortDirection: "desc", includeNative: true});
        expect(t.codex.lastParams("thread/items/list")).toEqual({threadId: THREAD_ID, turnId: "t1", cursor: {type: "item", itemId: "before"}, limit: 1, sortDirection: "desc"});
        expect(first.items[0]).toMatchObject({turnId: "t1", itemId: "mixed", startedAtMs: 10, completedAtMs: 20, _meta: {codex: {item: mixed}}});
        await expect(t.agent.sessionHistoryItems({sessionId: THREAD_ID, turnId: "another", cursor: first.nextCursor!})).rejects.toMatchObject({data: {reason: "history_invalid_cursor"}});
        await expect(t.agent.sessionHistory({sessionId: THREAD_ID, cursor: first.nextCursor!})).rejects.toMatchObject({data: {reason: "history_invalid_cursor"}});
    });

    it("keeps browse cursors usable after append while export cursors detect it", async () => {
        const t = await setup();
        let tailId = "tail1";
        t.codex.respond("thread/turns/list", (p: ThreadTurnsListParams) => ({data: [turn({id: p.sortDirection === "desc" ? tailId : "t1", itemsView: p.itemsView ?? "summary"})], nextCursor: p.sortDirection === "desc" ? null : "next", backwardsCursor: null}));
        const live = await t.agent.sessionHistory({sessionId: THREAD_ID});
        const stable = await t.agent.sessionHistory({sessionId: THREAD_ID, mode: "export"});
        tailId = "tail2";
        t.codex.respond("thread/turns/list", (p: ThreadTurnsListParams) => ({data: [turn({id: tailId, itemsView: p.itemsView ?? "summary"})], nextCursor: null, backwardsCursor: null}));
        await expect(t.agent.sessionHistory({sessionId: THREAD_ID, cursor: live.nextCursor!})).resolves.toMatchObject({complete: true});
        await expect(t.agent.sessionHistory({sessionId: THREAD_ID, mode: "export", cursor: stable.nextCursor!})).rejects.toMatchObject({data: {reason: "history_changed", retryable: true}});
    });

    it("bounds response size without truncating or advancing past omitted data", async () => {
        const t = await setup();
        t.codex.respond("thread/items/list", () => ({data: [{turnId: "t1", item: {...mixed, content: [{type: "text", text: "x".repeat(5000), text_elements: []}]}, startedAtMs: null, completedAtMs: null}], nextCursor: null, backwardsCursor: null}));
        await expect(t.agent.sessionHistoryItems({sessionId: THREAD_ID, maxBytes: 1024})).rejects.toMatchObject({data: {reason: "history_page_too_large", retryable: true}});
        const page = await t.agent.sessionHistoryItems({sessionId: THREAD_ID, maxBytes: 32768});
        expect(JSON.stringify(page)).toContain("x".repeat(5000));
    });

    it("preserves native error code and data and distinguishes known failures", async () => {
        const t = await setup();
        t.codex.respond("thread/read", () => { throw new ResponseError(-32602, "invalid cursor", {field: "cursor"}); });
        await expect(t.agent.sessionHistory({sessionId: THREAD_ID})).rejects.toMatchObject({code: -32602, data: {reason: "history_invalid_cursor", retryable: false, native: {code: -32602, data: {field: "cursor"}}}});
        t.codex.respond("thread/read", () => { throw new ResponseError(-32600, "thread not found", {id: THREAD_ID}); });
        await expect(t.agent.sessionHistoryItems({sessionId: THREAD_ID})).rejects.toMatchObject({data: {reason: "history_not_found", retryable: false}});
        t.codex.respond("thread/read", () => { throw Object.assign(new Error("offline"), {code: "ECONNRESET"}); });
        await expect(t.agent.sessionHistory({sessionId: THREAD_ID})).rejects.toMatchObject({data: {reason: "history_unavailable", retryable: true}});
    });

    it("reports projection loss at field level and offers native items for lossless source capture", async () => {
        const t = await setup();
        const item: ThreadItem = {type: "reasoning", id: "r", summary: ["short"], content: ["full reasoning"]};
        t.codex.respond("thread/items/list", () => ({data: [{turnId: "t1", item, startedAtMs: null, completedAtMs: null}], nextCursor: null, backwardsCursor: null}));
        const page = await t.agent.sessionHistoryItems({sessionId: THREAD_ID, includeNative: true});
        expect(page.items[0]?.omissions).toEqual(expect.arrayContaining([expect.objectContaining({itemId: "r", field: "content"})]));
        expect(page.items[0]?._meta?.codex.item).toEqual(item);
    });

    it("rejects mismatched direction, view and mode instead of silently skipping pages", async () => {
        const t = await setup();
        t.codex.respond("thread/turns/list", () => ({data: [turn({itemsView: "summary"})], nextCursor: "next", backwardsCursor: null}));
        const page = await t.agent.sessionHistory({sessionId: THREAD_ID});
        for (const extra of [{sortDirection: "desc" as const}, {itemsView: "full" as const}, {mode: "export" as const}]) {
            await expect(t.agent.sessionHistory({sessionId: THREAD_ID, cursor: page.nextCursor!, ...extra})).rejects.toMatchObject({data: {reason: "history_invalid_cursor"}});
        }
    });
});


describe("history v2 failure boundaries", () => {
    it.each([{mode: "other"}, {sortDirection: "sideways"}, {maxBytes: 1023}, {maxBytes: 16777217},
        {includeNative: "yes"}, {itemsView: "partial"}, {includeNative: true}, {misspelled: true}])("rejects invalid turn options %#", options => {
        expect(() => parseSessionHistoryParams({sessionId: THREAD_ID, ...options})).toThrow();
    });
    it.each([{anchorItemId: "i"}, {turnId: " "}, {turnId: "t", anchorItemId: "i", cursor: "c"}, {itemsView: "full"}])("rejects invalid item options %#", options => {
        expect(() => parseSessionHistoryItemsParams({sessionId: THREAD_ID, ...options})).toThrow();
    });
    it("cancels a pending item read without interrupting the session or making export follow-up reads", async () => {
        const t = await setup();
        let started!: () => void;
        const reached = new Promise<void>(resolve => { started = resolve; });
        t.codex.respond("thread/items/list", () => { started(); return new Promise(() => {}); });
        const stop = new AbortController();
        const pending = t.agent.sessionHistoryItems({sessionId: THREAD_ID, mode: "export"}, stop.signal);
        await reached;
        stop.abort();
        await expect(pending).rejects.toMatchObject({data: {reason: "history_cancelled", retryable: false}});
        expect(t.codex.calls("thread/read")).toHaveLength(1);
        expect(t.codex.calls("turn/interrupt")).toHaveLength(0);
    });
    it("does not classify unknown RPC failures as retryable or discard their native data", async () => {
        const t = await setup();
        t.codex.respond("thread/items/list", () => { throw new ResponseError(-32040, "unrecognized source failure", {tag: "keep"}); });
        await expect(t.agent.sessionHistoryItems({sessionId: THREAD_ID})).rejects.toMatchObject({code: -32040, data: {reason: "history_source_error", retryable: null, native: {code: -32040, data: {tag: "keep"}}}});
    });
    it("preserves unprojected native outputs and reports their omission", async () => {
        const t = await setup();
        const item: ThreadItem = {type: "functionCallOutput", id: "output", name: "f", namespace: null, output: "exact source output"};
        t.codex.respond("thread/items/list", () => ({data: [{turnId: "t1", item, startedAtMs: null, completedAtMs: null}], nextCursor: null, backwardsCursor: null}));
        const page = await t.agent.sessionHistoryItems({sessionId: THREAD_ID, includeNative: true});
        expect(page.items[0]).toMatchObject({updates: [], omissions: [{itemId: "output", field: "*", reason: "no_acp_representation"}], _meta: {codex: {item}}});
    });
    it("applies the same payload cap to whole-turn reads", async () => {
        const t = await setup();
        t.codex.respond("thread/turns/list", () => ({data: [turn({items: [{...mixed, content: [{type: "text", text: "x".repeat(4000), text_elements: []}]}]})], nextCursor: null, backwardsCursor: null}));
        await expect(t.agent.sessionHistory({sessionId: THREAD_ID, itemsView: "full", maxBytes: 1024})).rejects.toMatchObject({data: {reason: "history_page_too_large"}});
    });
});
