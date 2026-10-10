import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {TurnStartParams} from "../app-server/v2";
import {describe, expect, it} from "vitest";
import {createTestAgent, itemStarted, itemCompleted, THREAD_ID, turn, turnCompleted} from "./harness";

describe("command receipts", () => {
    it.each(["/status", "/mcp", "/skills", "/plan", "/compact", "/logout", "/review", "/review-branch main", "/review-commit abc", "/review-branch", "/review-commit"])("echoes %s before its output", async (text) => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        t.codex.respond("thread/compact/start", () => {
            setTimeout(() => itemCompleted(t.codex, {type: "contextCompaction", id: "compact"}), 0);
            return {};
        });
        t.codex.respond("account/logout", () => {
            setTimeout(() => t.codex.emit({method: "account/updated", params: {authMode: null, planType: null}}), 0);
            return {};
        });
        const prompt: acp.ContentBlock[] = [{type: "text", text}];
        const receipt = await t.agent.prompt({sessionId: THREAD_ID, prompt, _meta: {host: "command-test"}});
        await t.settle();
        expect(t.client.updatesOf("user_message")[0]).toMatchObject({messageId: receipt.messageId, content: prompt, _meta: {host: "command-test"}});
        if (text.startsWith("/review")) {
            t.codex.emit({method: "turn/completed", params: {threadId: THREAD_ID, turn: turn({id: "review-turn"})}});
            await t.settle();
        }
        expect(t.client.states().at(-1)).toBe("idle");
        const updates = t.client.updates();
        const echoIndex = updates.findIndex(update => update.sessionUpdate === "user_message");
        const outputIndex = updates.findIndex(update => ["agent_message_chunk", "compaction_update"].includes(update.sessionUpdate));
        if (outputIndex !== -1) expect(echoIndex).toBeLessThan(outputIndex);
    });

    it("keeps the review receipt and original text when Codex echoes its own user item", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        const prompt: acp.ContentBlock[] = [{type: "text", text: "/review focus on tests"}];
        const receipt = await t.agent.prompt({sessionId: THREAD_ID, prompt, _meta: {host: "review"}});
        await t.settle();
        itemStarted(t.codex, {type: "userMessage", id: "native-review-user", clientId: null, content: [{type: "text", text: "focus on tests", text_elements: []}]}, "review-turn");
        await t.settle();
        const echoes = t.client.updatesOf("user_message");
        expect(echoes.length).toBeGreaterThan(0);
        expect(new Set(echoes.map(echo => echo.messageId))).toEqual(new Set([receipt.messageId]));
        expect(echoes.at(-1)).toMatchObject({content: prompt, _meta: {host: "review", codex: {turnId: "review-turn"}}});
        t.codex.emit({method: "turn/completed", params: {threadId: THREAD_ID, turn: turn({id: "review-turn"})}});
        await t.settle();
        const next = await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "next"}]});
        await t.settle();
        itemStarted(t.codex, {type: "userMessage", id: "next-native", clientId: next.messageId, content: [{type: "text", text: "next", text_elements: []}]});
        await t.settle();
        expect(t.client.updatesOf("user_message").at(-1)).toMatchObject({messageId: next.messageId, content: [{type: "text", text: "next"}]});
        turnCompleted(t.codex);
    });

    it.each([false, true])("executes /plan arguments in plan mode (already enabled: %s)", async (alreadyEnabled) => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        if (alreadyEnabled) await t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "collaboration_mode", type: "id", value: "plan"});
        const prompt: acp.ContentBlock[] = [{type: "text", text: "/plan inspect files"}, {type: "text", text: "extra context"}];
        const receipt = await t.agent.prompt({sessionId: THREAD_ID, prompt});
        await t.settle();
        expect(t.codex.lastParams<TurnStartParams>("turn/start")).toMatchObject({clientUserMessageId: receipt.messageId, input: [{type: "text", text: "inspect files"}, {type: "text", text: "extra context"}]});
        expect(t.codex.lastParams("thread/settings/update")).toMatchObject({collaborationMode: {mode: "plan"}});
        itemStarted(t.codex, {type: "userMessage", id: "native-plan", clientId: receipt.messageId, content: [{type: "text", text: "inspect files", text_elements: []}]});
        await t.settle();
        expect(t.client.updatesOf("user_message").at(-1)).toMatchObject({messageId: receipt.messageId, content: prompt});
        turnCompleted(t.codex);
    });

    it("confirms both bare /plan toggles", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        for (const mode of ["enabled", "disabled"]) {
            await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/plan"}]});
            await t.settle();
            expect(t.client.updatesOf("agent_message_chunk").at(-1)?.content).toEqual({type: "text", text: `Plan mode ${mode}.`});
        }
    });

    it.each(["/unknown do work", "/$my-skill"])("leaves %s on the native prompt path", async (text) => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        const receipt = await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text}]});
        await t.settle();
        expect(t.client.updatesOf("user_message")).toMatchObject([{messageId: receipt.messageId, content: [{type: "text", text}]}]);
        expect(t.codex.lastParams<TurnStartParams>("turn/start")).toMatchObject({clientUserMessageId: receipt.messageId, input: [{type: "text", text}]});
        turnCompleted(t.codex);
    });

    it("keeps steering echoes distinct and completes cancelled reviews", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        const receipt = await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/review"}]});
        await t.settle();
        itemStarted(t.codex, {type: "userMessage", id: "steered", clientId: "steer-receipt", content: [{type: "text", text: "additional instructions", text_elements: []}]}, "review-turn");
        itemStarted(t.codex, {type: "userMessage", id: "review-native", clientId: null, content: [{type: "text", text: "review", text_elements: []}]}, "review-turn");
        await t.settle();
        expect(t.client.updatesOf("user_message").map(update => update.messageId)).toEqual([receipt.messageId, "steer-receipt", receipt.messageId]);
        t.codex.respond("turn/interrupt", () => {
            setTimeout(() => turnCompleted(t.codex, {id: "review-turn", status: "interrupted"}), 0);
            return {};
        });
        await t.agent.cancel({sessionId: THREAD_ID});
        await t.settle();
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "cancelled"});
    });

    it("claims the command even when execution fails", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        t.codex.respond("review/start", () => { throw new Error("Review unavailable"); });
        const receipt = await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/review"}]});
        await t.settle();
        expect(t.client.updatesOf("user_message")[0]?.messageId).toBe(receipt.messageId);
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "error"});
    });
});
