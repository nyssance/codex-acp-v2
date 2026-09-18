import {describe, expect, it} from "vitest";
import {createTestAgent, THREAD_ID, TURN_ID, turnCompleted} from "./harness";
import type {DynamicToolCallParams, DynamicToolCallResponse, ThreadStartParams} from "../app-server/v2";

const tools = {version: 1, revision: "board-v1", definitions: [{name: "read_canvas", description: "Read canvas", inputSchema: {type: "object", properties: {}}}]};
const meta = {alwith: {tools}};
const call = (overrides: Partial<DynamicToolCallParams> = {}): DynamicToolCallParams => ({threadId: THREAD_ID, turnId: TURN_ID, callId: "call-1", tool: "alwith_client_read_canvas", namespace: null, arguments: {}, ...overrides});

async function start() {
    const t = createTestAgent();
    await t.initialize();
    await t.openSession({_meta: meta});
    t.client.permissionResponder = () => ({outcome: {outcome: "selected", optionId: "allow_once"}});
    await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "go"}]});
    await t.settle();
    t.client.clear();
    return t;
}

describe("client tool callbacks", () => {
    it("declares tools before the first turn and keeps ordinary tool waiting in running", async () => {
        const t = await start();
        expect(t.codex.lastParams<ThreadStartParams>("thread/start").dynamicTools).toEqual([{...tools.definitions[0], type: "function", name: "alwith_client_read_canvas", deferLoading: false}]);
        let release!: (value: unknown) => void;
        t.client.toolResponder = () => new Promise(resolve => {release = resolve;});
        const pending = t.codex.serverRequest<DynamicToolCallResponse>("item/tool/call", call());
        await t.settle();
        expect(t.client.states()).toEqual(["requires_action", "running"]);
        expect(t.client.requests.at(-1)).toMatchObject({method: "_alwith/tool/call", params: {sessionId: THREAD_ID, turnId: TURN_ID, toolCallId: "call-1", name: "read_canvas", toolSetRevision: "board-v1"}});
        release({success: true, contentItems: [{type: "image", mimeType: "image/png", data: "AA=="}]});
        expect(await pending).toEqual({success: true, contentItems: [{type: "inputImage", imageUrl: "data:image/png;base64,AA=="}]});
    });

    it("deduplicates writes and refuses conflicting IDs, undeclared tools and stale turns", async () => {
        const t = await start();
        const first = t.codex.serverRequest("item/tool/call", call());
        expect(await t.codex.serverRequest("item/tool/call", call())).toEqual(await first);
        for (const params of [call({arguments: {changed: true}}), call({tool: "shell"}), call({turnId: "old"})]) {
            expect(await t.codex.serverRequest("item/tool/call", params)).toMatchObject({success: false});
        }
        expect(t.client.requests.filter(r => r.method === "_alwith/tool/call")).toHaveLength(1);
    });

    it("denied permissions never invoke the host", async () => {
        const t = await start();
        t.client.permissionResponder = () => ({outcome: {outcome: "cancelled"}});
        expect(await t.codex.serverRequest("item/tool/call", call())).toMatchObject({success: false});
        expect(t.client.requests.filter(r => r.method === "_alwith/tool/call")).toHaveLength(0);
    });

    it("cancels pending callbacks and isolates their late replies from the next turn", async () => {
        const t = await start();
        let release!: (value: unknown) => void;
        t.client.toolResponder = () => new Promise(resolve => {release = resolve;});
        const pending = t.codex.serverRequest("item/tool/call", call());
        await t.settle();
        await t.agent.cancel({sessionId: THREAD_ID});
        expect(await pending).toMatchObject({success: false});
        turnCompleted(t.codex, {status: "interrupted"});
        await t.settle();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "next"}]});
        await t.settle();
        t.client.toolResponder = () => ({success: true, contentItems: [{type: "text", text: "new"}]});
        release({success: true, contentItems: [{type: "text", text: "old"}]});
        expect(await t.codex.serverRequest("item/tool/call", call())).toEqual({success: true, contentItems: [{type: "inputText", text: "new"}]});
    });

    it("rejects malformed declarations and refuses unbounded resource fetching", async () => {
        const t = createTestAgent();
        await t.initialize();
        await expect(t.openSession({_meta: {alwith: {tools: {...tools, definitions: [...tools.definitions, ...tools.definitions]}}}})).rejects.toThrow("unique");
        const active = await start();
        active.client.toolResponder = () => ({success: true, contentItems: [{type: "resource", uri: "https://private.example/secret"}]});
        expect(await active.codex.serverRequest("item/tool/call", call())).toMatchObject({success: false});
        active.client.toolResponder = () => ({success: true, contentItems: [{type: "text", text: "healthy"}]});
        expect(await active.codex.serverRequest("item/tool/call", call({callId: "call-2"}))).toMatchObject({success: true});
    });
});
