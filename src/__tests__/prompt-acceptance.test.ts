import {describe, expect, it} from "vitest";
import {ResponseError} from "vscode-jsonrpc/node";
import {createTestAgent, itemStarted, THREAD_ID, turnCompleted} from "./harness";

describe("prompt insertion", () => {
    it("reports an accepted ordinary prompt even when native startup is rejected", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        t.codex.respond("turn/start", () => { throw new ResponseError(-32602, "Invalid native parameters"); });
        const prompt = [{type: "text" as const, text: "ordinary work"}];
        const accepted = await t.agent.prompt({sessionId: THREAD_ID, prompt});
        await t.settle();
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "error"});
        expect(t.client.updatesOf("user_message")).toContainEqual(expect.objectContaining({messageId: accepted.messageId, content: prompt}));
    });

    it.each([false, true])("inserts locally while native startup is pending (cancel: %s)", async cancel => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        const prompt = [{type: "text" as const, text: "ordinary work"}];
        let release!: () => void;
        t.codex.respond("skills/list", async () => {
            await new Promise<void>(resolve => { release = resolve; });
            return {data: []};
        });
        t.codex.emit({method: "skills/changed", params: {}});
        const accepted = await t.agent.prompt({sessionId: THREAD_ID, prompt, _meta: {host: "acceptance"}});
        try {
            expect(t.client.updatesOf("user_message")).toMatchObject([{messageId: accepted.messageId, content: prompt, _meta: {host: "acceptance"}}]);
            expect(t.codex.calls("turn/start")).toHaveLength(0);
            if (cancel) {
                await t.agent.cancel({sessionId: THREAD_ID});
                await t.settle();
                expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "cancelled"});
            }
        } finally { release(); }
        await t.settle();
        if (cancel) {
            expect(t.codex.calls("turn/start")).toHaveLength(0);
            expect(t.client.updatesOf("user_message")).toMatchObject([{messageId: accepted.messageId, content: prompt}]);
            return;
        }
        itemStarted(t.codex, {type: "userMessage", id: "native-user", clientId: accepted.messageId, content: [{type: "text", text: "ordinary work", text_elements: []}]});
        await t.settle();
        expect(new Set(t.client.updatesOf("user_message").map(update => update.messageId))).toEqual(new Set([accepted.messageId]));
        expect(t.client.updatesOf("user_message").at(-1)).toMatchObject({content: prompt});
        turnCompleted(t.codex);
    });

    it("does not insert a rejected empty prompt", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await expect(t.agent.prompt({sessionId: THREAD_ID, prompt: []})).rejects.toMatchObject({code: -32602});
        expect(t.client.updatesOf("user_message")).toHaveLength(0);
        expect(t.codex.calls("turn/start")).toHaveLength(0);
    });
});
