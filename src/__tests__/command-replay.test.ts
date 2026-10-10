import {describe, expect, it, vi} from "vitest";
import {ResponseError} from "vscode-jsonrpc/node";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {CommandReceipts, type CommandReceipt} from "../agent/commandReceipts";
import {historyUpdates} from "../agent/history";
import {createTestAgent, CWD, itemStarted, threadResponse, THREAD_ID, turn, turnCompleted} from "./harness";

describe("command history projection", () => {
    it.each(["/review", "/plan inspect"])("does not execute %s when history protection fails", async (text) => {
        const receipts = new CommandReceipts();
        vi.spyOn(receipts, "prepare").mockRejectedValue(new Error("history directory is read-only"));
        const t = createTestAgent({commandReceipts: receipts});
        await t.initialize();
        await t.openSession();
        const accepted = await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text}]});
        await t.settle();
        expect(t.codex.calls("review/start")).toHaveLength(0);
        expect(t.codex.calls("turn/start")).toHaveLength(0);
        expect(t.client.updatesOf("user_message")[0]?.messageId).toBe(accepted.messageId);
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "error"});
    });

    it("cancels pending history protection without starting native work when it settles late", async () => {
        const receipts = new CommandReceipts();
        const prepare = receipts.prepare.bind(receipts);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let started!: () => void;
        const preparing = new Promise<void>(resolve => { started = resolve; });
        vi.spyOn(receipts, "prepare").mockImplementation(async threadId => { started(); await gate; return await prepare(threadId); });
        const t = createTestAgent({commandReceipts: receipts, cancelGraceMs: 20});
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/review"}]});
        // Cancel at the preparation barrier; timer draining can exceed the 20ms budget on Windows.
        await preparing;
        await t.agent.cancel({sessionId: THREAD_ID});
        await t.settle();
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "cancelled"});
        release();
        await t.settle();
        expect(t.codex.calls("review/start")).toHaveLength(0);
        await expect(receipts.assertReplayable(THREAD_ID)).resolves.toBeUndefined();
    });

    it("replays a successfully saved review with the original identity after restart", async () => {
        const home = await mkdtemp(path.join(tmpdir(), "acp-receipt-saved-"));
        const t = createTestAgent({commandReceipts: new CommandReceipts(home)});
        await t.initialize();
        await t.openSession();
        const prompt = [{type: "text" as const, text: "/review"}];
        const accepted = await t.agent.prompt({sessionId: THREAD_ID, prompt});
        await t.settle();
        const native = {type: "userMessage" as const, id: "saved-review", clientId: null, content: [{type: "text" as const, text: "Review current changes", text_elements: []}]};
        itemStarted(t.codex, native, "review-turn");
        turnCompleted(t.codex, {id: "review-turn"});
        await expect.poll(() => t.client.states().at(-1)).toBe("idle");
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "end_turn"});
        const fresh = createTestAgent({commandReceipts: new CommandReceipts(home)});
        await fresh.initialize();
        fresh.codex.respond("thread/turns/list", () => ({data: [turn({id: "review-turn", items: [native]})], nextCursor: null, backwardsCursor: null}));
        await fresh.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD, replayFrom: {type: "start"}});
        expect(fresh.client.updatesOf("user_message")).toMatchObject([{messageId: accepted.messageId, content: prompt}]);
    });

    it.each(["resume", "fork", "turns", "items"])("rejects %s after restarting with a failed review receipt save", async (endpoint) => {
        const home = await mkdtemp(path.join(tmpdir(), "acp-receipt-replay-"));
        const receipts = new CommandReceipts(home);
        vi.spyOn(receipts, "write").mockRejectedValue(new Error("disk full"));
        const t = createTestAgent({commandReceipts: receipts});
        await t.initialize();
        await t.openSession();
        const accepted = await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/review"}]});
        await t.settle();
        const native = {type: "userMessage" as const, id: "native-review", clientId: null, content: [{type: "text" as const, text: "Review current changes", text_elements: []}]};
        itemStarted(t.codex, native, "review-turn");
        await t.settle();
        turnCompleted(t.codex, {id: "review-turn"});
        await t.settle();
        expect(t.client.updatesOf("user_message")[0]?.messageId).toBe(accepted.messageId);
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "error"});

        const fresh = createTestAgent({commandReceipts: new CommandReceipts(home)});
        await fresh.initialize();
        fresh.codex.respond("thread/turns/list", () => ({data: [turn({id: "review-turn", items: [native]})], nextCursor: null, backwardsCursor: null}));
        fresh.codex.respond("thread/items/list", () => ({data: [{turnId: "review-turn", item: native, startedAtMs: null, completedAtMs: null}], nextCursor: null, backwardsCursor: null}));
        const request = endpoint === "resume" ? fresh.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD, replayFrom: {type: "start"}})
            : endpoint === "fork" ? fresh.agent.forkSession({sessionId: THREAD_ID, cwd: CWD})
            : endpoint === "turns" ? fresh.agent.sessionHistory({sessionId: THREAD_ID, itemsView: "full"})
            : fresh.agent.sessionHistoryItems({sessionId: THREAD_ID});
        await expect(request).rejects.toMatchObject({data: {reason: "command_history_incomplete"}});
        expect(fresh.client.updatesOf("user_message")).toHaveLength(0);
    });

    it("keeps the command content when restoring an active turn after replay", async () => {
        const commandReceipts = new CommandReceipts();
        await commandReceipts.write("plan-native", {kind: "plan", messageId: "plan-receipt", content: [{type: "text", text: "/plan inspect files"}]});
        const t = createTestAgent({commandReceipts});
        await t.initialize();
        t.codex.respond("thread/resume", () => threadResponse({status: {type: "active", activeFlags: []}}));
        t.codex.respond("thread/turns/list", () => ({data: [turn({id: "active-plan", status: "inProgress", items: [
            {type: "userMessage", id: "plan-native", clientId: "plan-receipt", content: [{type: "text", text: "inspect files", text_elements: []}]},
        ]})], nextCursor: null, backwardsCursor: null}));
        await t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD, replayFrom: {type: "start"}});
        await t.settle();
        itemStarted(t.codex, {type: "userMessage", id: "plan-native", clientId: "plan-receipt", content: [{type: "text", text: "inspect files", text_elements: []}]}, "active-plan");
        await t.settle();
        expect(t.client.updatesOf("user_message").map(update => ({messageId: update.messageId, content: update.content}))).toEqual([
            {messageId: "plan-receipt", content: [{type: "text", text: "/plan inspect files"}]},
            {messageId: "plan-receipt", content: [{type: "text", text: "/plan inspect files"}]},
            {messageId: "plan-receipt", content: [{type: "text", text: "/plan inspect files"}]},
        ]);
        turnCompleted(t.codex, {id: "active-plan"});
    });

    it("replays inherited command items under their original receipts without exposing internal plan input", () => {
        const plan: CommandReceipt = {kind: "plan", messageId: "plan-receipt", content: [{type: "text", text: "/plan inspect files"}]};
        const review: CommandReceipt = {kind: "review", messageId: "review-receipt", content: [{type: "text", text: "/review"}]};
        const inherited = [
            turn({id: "plan-turn", items: [{type: "userMessage", id: "plan-native", clientId: "plan-receipt", content: [{type: "text", text: "inspect files", text_elements: []}]}]}),
            turn({id: "internal-turn", items: [{type: "userMessage", id: "internal-native", clientId: "codex-acp-internal-plan:internal", content: [{type: "text", text: "Implement the approved plan.", text_elements: []}]}]}),
            turn({id: "review-turn", items: [{type: "userMessage", id: "review-native", clientId: null, content: [{type: "text", text: "Review the current code changes", text_elements: []}]}]}),
            turn({id: "foreign-turn", items: [{type: "userMessage", id: "foreign-native", clientId: null, content: [{type: "text", text: "foreign prompt", text_elements: []}]}]}),
        ];
        const updates = historyUpdates(inherited, new Map([["plan-native", plan], ["review-native", review]]));
        expect(updates.flatMap(update => update.sessionUpdate === "user_message" ? [{messageId: update.messageId, content: update.content}] : [])).toEqual([
            {messageId: "plan-receipt", content: [{type: "text", text: "/plan inspect files"}]},
            {messageId: "review-receipt", content: [{type: "text", text: "/review"}]},
            {messageId: "foreign-native", content: [{type: "text", text: "foreign prompt"}]},
        ]);
    });
});

describe("command start rejection", () => {
    it.each([
        {prompt: "/review", method: "review/start"},
        {prompt: "/plan inspect", method: "turn/start"},
    ])("keeps history replayable across restart after $prompt is explicitly rejected", async ({prompt, method}) => {
        const home = await mkdtemp(path.join(tmpdir(), "acp-command-rejected-"));
        const t = createTestAgent({commandReceipts: new CommandReceipts(home)});
        await t.initialize();
        await t.openSession();
        t.codex.respond(method, () => { throw new ResponseError(-32602, "Invalid parameters; command not started"); });
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: prompt}]});
        await expect.poll(() => t.client.states().at(-1)).toBe("idle");
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "error"});
        const fresh = createTestAgent({commandReceipts: new CommandReceipts(home)});
        await fresh.initialize();
        fresh.codex.respond("thread/turns/list", () => ({data: [turn({items: [
            {type: "userMessage", id: "old-item", clientId: "old-receipt", content: [{type: "text", text: "previous work", text_elements: []}]},
        ]})], nextCursor: null, backwardsCursor: null}));
        await fresh.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD, replayFrom: {type: "start"}});
        expect(fresh.client.updatesOf("user_message")).toMatchObject([{messageId: "old-receipt"}]);
    });

    it.each(["transport", "internal", "activity"])("retains the history guard after an uncertain start (%s)", async (failure) => {
        const receipts = new CommandReceipts();
        const t = createTestAgent({commandReceipts: receipts});
        await t.initialize();
        await t.openSession();
        t.codex.respond("review/start", () => {
            if (failure === "activity") t.codex.emit({method: "turn/started", params: {threadId: THREAD_ID, turn: turn({id: "review-turn", status: "inProgress"})}});
            throw failure === "transport" ? new Error("Connection lost") : new ResponseError(failure === "internal" ? -32603 : -32602, "Start failed");
        });
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/review"}]});
        await t.settle();
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "error"});
        await expect(receipts.assertReplayable(THREAD_ID)).rejects.toMatchObject({data: {reason: "command_history_incomplete"}});
    });
});
