import {describe, expect, it, vi} from "vitest";
import {CommandReceipts} from "../agent/commandReceipts";
import {createTestAgent, itemStarted, thread, THREAD_ID, turn, turnCompleted} from "./harness";

describe("command receipt persistence failures", () => {
    it("streams updates while saving and waits for a successful save before idle", async () => {
        const receipts = new CommandReceipts();
        const save = receipts.write.bind(receipts);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(receipts, "write").mockImplementation(async (itemId, receipt) => {
            await gate;
            await save(itemId, receipt);
        });
        const t = createTestAgent({commandReceipts: receipts});
        await t.initialize();
        await t.openSession();
        const prompt = [{type: "text" as const, text: "/plan inspect"}];
        const receipt = await t.agent.prompt({sessionId: THREAD_ID, prompt});
        await t.settle();
        itemStarted(t.codex, {type: "userMessage", id: "saved-item", clientId: receipt.messageId, content: [{type: "text", text: "inspect", text_elements: []}]});
        t.codex.emit({method: "item/agentMessage/delta", params: {threadId: THREAD_ID, turnId: "turn-1", itemId: "answer", delta: "done"}});
        turnCompleted(t.codex);
        try {
            await t.settle();
            expect(t.client.updatesOf("agent_message_chunk").at(-1)?.content).toMatchObject({text: "done"});
            expect(t.client.states()).toEqual(["running"]);
        } finally { release(); }
        await t.settle();
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "end_turn"});
        expect(await receipts.read("saved-item")).toMatchObject({messageId: receipt.messageId, content: prompt});
    });

    it.each([true, false])("finishes cancellation despite a stalled write (native completion: %s)", async (completion) => {
        const receipts = new CommandReceipts();
        let rejectWrite!: (reason: Error) => void;
        vi.spyOn(receipts, "write").mockImplementation(() => new Promise<void>((_, reject) => { rejectWrite = reject; }));
        const t = createTestAgent({commandReceipts: receipts, cancelGraceMs: 20});
        await t.initialize();
        await t.openSession();
        const receipt = await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/plan inspect"}]});
        await t.settle();
        itemStarted(t.codex, {type: "userMessage", id: "stalled-item", clientId: receipt.messageId, content: [{type: "text", text: "inspect", text_elements: []}]});
        await t.settle();
        t.codex.emit({method: "item/agentMessage/delta", params: {threadId: THREAD_ID, turnId: "turn-1", itemId: "progress", delta: "Working"}});
        t.codex.respond("turn/interrupt", () => {
            if (completion) turnCompleted(t.codex, {status: "interrupted"});
            return {};
        });
        t.codex.respond("thread/read", () => ({thread: thread({status: {type: "idle"}})}));
        try {
            await t.agent.cancel({sessionId: THREAD_ID});
            await expect.poll(() => t.client.states().at(-1), {timeout: 1_000}).toBe("idle");
            expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "cancelled"});
            expect(t.client.updatesOf("agent_message_chunk").some(update => update.messageId === "progress")).toBe(true);
            expect(t.client.updatesOf("agent_message").some(update => JSON.stringify(update.content).includes("command history"))).toBe(true);

            t.codex.respond("turn/start", () => ({turn: turn({id: "next-turn", status: "inProgress"})}));
            await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "next"}]});
            await t.settle();
            const updates = t.client.updates().length;
            rejectWrite(new Error("late disk failure"));
            await t.settle();
            expect(t.client.updates()).toHaveLength(updates);
            expect(t.client.states()).toEqual(["running", "idle", "running"]);
        } finally {
            rejectWrite(new Error("disk failure"));
            turnCompleted(t.codex, {id: "next-turn"});
            turnCompleted(t.codex, {status: "interrupted"});
            await t.settle();
        }
    });

    it("reports a write failure registered behind queued notifications after native completion", async () => {
        const receipts = new CommandReceipts();
        vi.spyOn(receipts, "write").mockRejectedValue(new Error("receipt disk full"));
        const t = createTestAgent({commandReceipts: receipts});
        await t.initialize();
        await t.openSession();
        const receipt = await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/plan inspect"}]});
        await t.settle();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(t.client, "notify").mockImplementationOnce(async () => { await gate; });
        t.codex.emit({method: "item/agentMessage/delta", params: {threadId: THREAD_ID, turnId: "turn-1", itemId: "answer", delta: "done"}});
        itemStarted(t.codex, {type: "userMessage", id: "failed-item", clientId: receipt.messageId, content: [{type: "text", text: "inspect", text_elements: []}]});
        turnCompleted(t.codex);
        await t.settle();
        release();
        await t.settle();
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "error"});
        expect(t.client.updatesOf("agent_message_chunk").at(-1)?.content).toMatchObject({text: expect.stringContaining("receipt disk full")});
    });

    it("bounds a stalled write after normal completion and reports the saving failure", async () => {
        const receipts = new CommandReceipts();
        vi.spyOn(receipts, "write").mockImplementation(() => new Promise<void>(() => {}));
        const t = createTestAgent({commandReceipts: receipts, cancelGraceMs: 20});
        await t.initialize();
        await t.openSession();
        const receipt = await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/plan inspect"}]});
        await t.settle();
        itemStarted(t.codex, {type: "userMessage", id: "pending-item", clientId: receipt.messageId, content: [{type: "text", text: "inspect", text_elements: []}]});
        turnCompleted(t.codex);
        await expect.poll(() => t.client.states().at(-1), {timeout: 1_000}).toBe("idle");
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "error"});
        expect(t.client.updatesOf("agent_message_chunk").at(-1)?.content).toMatchObject({text: expect.stringContaining("command history")});
    });
});
