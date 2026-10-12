import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {parseSessionListParams} from "../agent/CodexAgent";
import {createAgentApp} from "../agent/createAgent";
import {AppServerClient} from "../codex/AppServerClient";
import {createTestAgent, CWD, expectRejects, thread} from "./harness";

function pagedAgent() {
    const t = createTestAgent();
    t.codex.respond("thread/list", params => ({
        data: params.cursor === "p2"
            ? [thread({id: "a", name: "Updated title"}), thread({id: "b", cwd: "/other-project"})]
            : [thread({id: "a", name: "Original title"})],
        nextCursor: params.cursor === "p2" ? null : "p2",
        backwardsCursor: null,
    }));
    return t;
}

describe("_codex/session_list", () => {
    it("requires initialization and advertises its versioned capability", async () => {
        const t = createTestAgent();
        await expectRejects(t.agent.sessionList(), -32600, "initialize");
        const result = await t.initialize();
        expect(result.capabilities?._meta).toMatchObject({codex: {sessionList: {version: 1}}});
    });

    it.each([undefined, null, {}, {cwd: undefined, cursor: undefined}])("collects every page for empty params %j", async raw => {
        const t = pagedAgent();
        await t.initialize();
        const result = await t.agent.sessionList(parseSessionListParams(raw));
        expect(result.sessions.map(session => session.sessionId)).toEqual(["a", "b"]);
        expect(result.sessions[0]?.title).toBe("Updated title");
        expect(result.sessions[1]?.cwd).toBe("/other-project");
        expect(result).not.toHaveProperty("nextCursor");
        expect(t.codex.calls("thread/list").map(call => call.params)).toEqual([
            {cursor: null, limit: 100, sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"], modelProviders: []},
            {cursor: "p2", limit: 100, sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"], modelProviders: []},
        ]);
    });

    it.each([{cwd: CWD}, {cursor: "p2"}, {_meta: {codex: {archived: true}}}, {cwd: null}, {_meta: {}}])(
        "matches standard session/list for params %j", async params => {
            const t = pagedAgent();
            await t.initialize();
            const standard = await t.agent.listSessions(params);
            const standardCalls = t.codex.calls("thread/list").map(call => call.params);
            expect(await t.agent.sessionList(params)).toEqual(standard);
            expect(t.codex.calls("thread/list").slice(standardCalls.length).map(call => call.params)).toEqual(standardCalls);
        },
    );

    it("leaves standard empty-params listing paginated", async () => {
        const t = pagedAgent();
        await t.initialize();
        expect(await t.agent.listSessions({})).toMatchObject({sessions: [{sessionId: "a"}], nextCursor: "p2"});
        expect(t.codex.calls("thread/list")).toHaveLength(1);
    });

    it("continues after an empty page and returns an empty full list without a cursor", async () => {
        const t = createTestAgent();
        await t.initialize();
        expect(await t.agent.sessionList()).toEqual({sessions: []});
        t.codex.respond("thread/list", params => ({data: params.cursor ? [thread({id: "later"})] : [], nextCursor: params.cursor ? null : "p2", backwardsCursor: null}));
        expect((await t.agent.sessionList()).sessions.map(session => session.sessionId)).toEqual(["later"]);
    });

    it("rejects repeated cursors instead of looping or returning partial results", async () => {
        const t = createTestAgent();
        t.codex.respond("thread/list", () => ({data: [thread()], nextCursor: "same", backwardsCursor: null}));
        await t.initialize();
        await expectRejects(t.agent.sessionList(), -32603, "repeated a cursor");
        expect(t.codex.calls("thread/list")).toHaveLength(2);
    });

    it("rejects a failed later page", async () => {
        const t = createTestAgent();
        t.codex.respond("thread/list", params => {
            if (params.cursor) throw new Error("Cannot read second page");
            return {data: [thread()], nextCursor: "p2", backwardsCursor: null};
        });
        await t.initialize();
        await expect(t.agent.sessionList()).rejects.toThrow("Cannot read second page");
    });

    it("supplements native forks once after collecting pages, without duplicates", async () => {
        const home = await mkdtemp(path.join(os.tmpdir(), "session-list-"));
        const id = "01900000-0000-7000-8000-000000000001";
        const parent = "01900000-0000-7000-8000-000000000002";
        try {
            const directory = path.join(home, "sessions", "2026", "10", "12");
            await mkdir(directory, {recursive: true});
            await writeFile(path.join(directory, `rollout-test-${id}.jsonl`), JSON.stringify({type: "session_meta", payload: {id, forked_from_id: parent, cwd: CWD, source: "vscode"}}) + "\n");
            const t = createTestAgent();
            t.codex.respond("initialize", () => ({userAgent: "test", codexHome: home, platformFamily: "unix", platformOs: "macos"}));
            t.codex.respond("thread/read", () => ({thread: thread({id, sessionId: id, forkedFromId: parent, name: "Fork"})}));
            t.codex.respond("thread/list", params => ({data: params.cursor ? [thread({id})] : [], nextCursor: params.cursor ? null : "p2", backwardsCursor: null}));
            await t.initialize();
            const result = await t.agent.sessionList();
            expect(result.sessions).toEqual([expect.objectContaining({sessionId: id, title: "Fork", _meta: {codex: {archived: false, nativeSessionId: id, forkedFromId: parent}}})]);
            expect(t.codex.calls("thread/list")).toHaveLength(2);
            expect(t.codex.calls("thread/read")).toHaveLength(1);
            t.codex.respond("thread/list", () => ({data: [], nextCursor: null, backwardsCursor: null}));
            expect((await t.agent.sessionList()).sessions.map(session => session.sessionId)).toEqual([id]);
        } finally {
            await rm(home, {recursive: true, force: true});
        }
    });

    it("bounds history reads for titles and preserves explicit names", async () => {
        const t = createTestAgent();
        let active = 0, peak = 0;
        t.codex.respond("thread/list", () => ({data: Array.from({length: 40}, (_, index) => thread({id: `t${index}`, name: index === 0 ? "Named" : null, preview: "[@attachment"})), nextCursor: null, backwardsCursor: null}));
        t.codex.respond("thread/turns/list", async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise<void>(resolve => setImmediate(resolve));
            active -= 1;
            return {data: [], nextCursor: null, backwardsCursor: null};
        });
        await t.initialize();
        const result = await t.agent.sessionList();
        expect(result.sessions).toHaveLength(40);
        expect(result.sessions[0]?.title).toBe("Named");
        expect(t.codex.calls("thread/turns/list")).toHaveLength(39);
        expect(peak).toBeLessThanOrEqual(8);
    });

    it("registers the method over ACP and validates request fields", async () => {
        const t = pagedAgent();
        const upstream = new TransformStream<Uint8Array, Uint8Array>();
        const downstream = new TransformStream<Uint8Array, Uint8Array>();
        const server = createAgentApp({codex: new AppServerClient(t.codex.asMessageConnection()), info: {name: "list-test", version: "1"}, env: {}})
            .connect(acp.ndJsonStream(downstream.writable, upstream.readable));
        try {
            await acp.client({name: "list-client"}).connectWith(acp.ndJsonStream(upstream.writable, downstream.readable), async client => {
                await client.request("initialize", {protocolVersion: 2, info: {name: "list-client", version: "1"}});
                const full = await client.request<acp.ListSessionsResponse>("_codex/session_list");
                expect(full.sessions.map(session => session.sessionId)).toEqual(["a", "b"]);
                expect(full).not.toHaveProperty("nextCursor");
                const page = await client.request<acp.ListSessionsResponse>("_codex/session_list", {cwd: CWD});
                expect(page.nextCursor).toBe("p2");
                for (const params of [[], "bad", {cwd: 1}, {cursor: false}, {_meta: []}]) {
                    await expect(client.request("_codex/session_list", params)).rejects.toMatchObject({code: -32602});
                }
            });
        } finally {
            server.close();
            await server.closed;
        }
    });
});
