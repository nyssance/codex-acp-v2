import {describe, expect, it} from "vitest";
import {mkdtemp, mkdir, writeFile, rename, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createTestAgent, CWD, expectRejects, itemStarted, thread, threadResponse, THREAD_ID, turn, TURN_ID} from "./harness";
import {historyUpdates} from "../agent/history";

describe("chat branches", () => {
    it("restores the inherited boundary after a child has its own turns", async () => {
        const t = createTestAgent();
        t.codex.respond("thread/resume", () => threadResponse(thread({id: "child", forkedFromId: "parent"})));
        t.codex.respond("thread/turns/list", params => ({data: (params.threadId === "parent" ? ["t1", "t2", "later-parent"] : ["t1", "t2", "child-turn"]).map(id => turn({id})), nextCursor: null, backwardsCursor: null}));
        await t.initialize();
        const response = await t.agent.resumeSession({sessionId: "child", cwd: CWD, replayFrom: {type: "start"}});
        expect(response._meta).toMatchObject({codex: {forkedFromId: "parent", forkedAtTurnId: "t2"}});
    });

    it("rediscovers empty-preview native forks after restart, with archive and project filters", async () => {
        const home = await mkdtemp(path.join(os.tmpdir(), "fork-index-"));
        const id = "01900000-0000-7000-8000-000000000001";
        const parent = "01900000-0000-7000-8000-000000000002";
        const active = path.join(home, "sessions", "2026", "09", "24");
        const archive = path.join(home, "archived_sessions");
        const filename = `rollout-test-${id}.jsonl`;
        try {
            await mkdir(active, {recursive: true});
            await mkdir(archive);
            await writeFile(path.join(active, filename), JSON.stringify({type: "session_meta", payload: {
                id, forked_from_id: parent, cwd: CWD, source: "vscode",
            }}) + "\n" + "transcript body is deliberately not parsed");
            const t = createTestAgent();
            t.codex.respond("initialize", () => ({userAgent: "test", codexHome: home, platformFamily: "unix", platformOs: "macos"}));
            t.codex.respond("thread/read", () => ({thread: thread({id, sessionId: id, forkedFromId: parent, preview: "hydrated preview missing from native index"})}));
            await t.initialize();
            expect((await t.agent.listSessions({})).sessions).toEqual([expect.objectContaining({sessionId: id,
                _meta: {codex: {archived: false, nativeSessionId: id, forkedFromId: parent}},
            })]);
            expect((await t.agent.listSessions({cwd: CWD})).sessions).toHaveLength(1);
            expect((await t.agent.listSessions({cwd: "/unrelated"})).sessions).toHaveLength(0);
            expect((await t.agent.listSessions({cursor: "next-page"})).sessions).toHaveLength(0);
            t.codex.respond("thread/list", () => ({data: [thread({id})], nextCursor: null, backwardsCursor: null}));
            expect((await t.agent.listSessions({})).sessions[0]?._meta).toMatchObject({codex: {forkedFromId: parent}});
            t.codex.respond("thread/list", params => params.cursor === "page-2"
                ? {data: [thread({id})], nextCursor: null, backwardsCursor: null}
                : {data: [], nextCursor: "page-2", backwardsCursor: null});
            expect((await t.agent.listSessions({})).sessions).toHaveLength(0);
            expect((await t.agent.listSessions({cursor: "page-2"})).sessions[0]?._meta).toMatchObject({codex: {forkedFromId: parent}});
            t.codex.respond("thread/list", () => ({data: [], nextCursor: null, backwardsCursor: null}));
            await rename(path.join(active, filename), path.join(archive, filename));
            expect((await t.agent.listSessions({})).sessions).toHaveLength(0);
            expect((await t.agent.listSessions({_meta: {codex: {archived: true}}})).sessions[0]?._meta).toMatchObject({codex: {archived: true}});
            await rm(path.join(archive, filename));
            expect((await t.agent.listSessions({_meta: {codex: {archived: true}}})).sessions).toHaveLength(0);
        } finally { await rm(home, {recursive: true, force: true}); }
    });

    it("forwards the inclusive turn boundary, replays the new thread and exposes Codex lineage", async () => {
        const t = createTestAgent();
        const initialized = await t.initialize();
        expect(initialized.capabilities?._meta).toMatchObject({codex: {forkAtTurn: true, sessionLineage: true}});
        t.codex.respond("thread/turns/list", params => ({data: params.threadId === "thread-fork" ? [turn({items: [
            {type: "agentMessage", id: "answer", text: "Kept answer", phase: "final_answer", memoryCitation: null, delivery: null, questions: null},
        ]})] : [], nextCursor: null, backwardsCursor: null}));
        const fork = await t.agent.forkSession({sessionId: THREAD_ID, cwd: CWD, _meta: {codex: {lastTurnId: TURN_ID}}});
        expect(t.codex.lastParams("thread/fork")).toMatchObject({threadId: THREAD_ID, lastTurnId: TURN_ID});
        expect(fork._meta).toEqual({codex: {nativeSessionId: THREAD_ID, forkedFromId: THREAD_ID, forkedAtTurnId: null}});
        expect(t.client.updatesOf("agent_message")).toEqual([expect.objectContaining({
            sessionId: "thread-fork", messageId: "answer", _meta: {codex: {phase: "final_answer", turnId: TURN_ID}},
        })]);
        expect(t.codex.calls("thread/turns/list").some(call => (call.params as {threadId: string}).threadId === "thread-fork")).toBe(true);
    });

    it("rejects malformed boundaries before creating a fork and preserves whole-chat forks", async () => {
        const t = createTestAgent();
        await t.initialize();
        for (const lastTurnId of [null, "", " ", 12, {}]) {
            await expectRejects(t.agent.forkSession({sessionId: THREAD_ID, cwd: CWD, _meta: {codex: {lastTurnId}}}), -32602, "lastTurnId");
        }
        expect(t.codex.calls("thread/fork")).toHaveLength(0);
        await t.agent.forkSession({sessionId: THREAD_ID, cwd: CWD});
        expect(t.codex.lastParams("thread/fork")).not.toHaveProperty("lastTurnId");
    });

    it("preserves native lineage in lists and resume without treating subagents as forks", async () => {
        const t = createTestAgent();
        const child = thread({id: "child", sessionId: "tree", forkedFromId: "parent", parentThreadId: null});
        t.codex.respond("thread/list", () => ({data: [child], nextCursor: null, backwardsCursor: null}));
        t.codex.respond("thread/resume", () => threadResponse(child));
        await t.initialize();
        expect((await t.agent.listSessions({})).sessions[0]?._meta).toEqual({codex: {archived: false, nativeSessionId: "tree", forkedFromId: "parent"}});
        expect((await t.agent.resumeSession({sessionId: "child", cwd: CWD}))._meta).toEqual({codex: {nativeSessionId: "tree", forkedFromId: "parent"}});
    });

    it("carries the same turn identity on live messages and restored history", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "hello"}]});
        await t.settle();
        t.codex.emit({method: "turn/started", params: {threadId: THREAD_ID, turn: turn({startedAt: 1_790_000_000})}});
        const item = {type: "agentMessage" as const, id: "answer", text: "Hello", phase: "final_answer" as const, memoryCitation: null, delivery: null, questions: null};
        itemStarted(t.codex, item);
        t.codex.emit({method: "item/agentMessage/delta", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "answer", delta: "Hello"}});
        await t.settle();
        expect(t.client.updatesOf("agent_message_chunk").at(-1)?._meta).toEqual({codex: {phase: "final_answer", turnId: TURN_ID, turnStartedAt: 1_790_000_000_000}});
        expect(historyUpdates([turn({items: [item]})])[0]?._meta).toEqual({codex: {phase: "final_answer", turnId: TURN_ID}});
        expect(historyUpdates([turn({items: [item], startedAt: 1_790_000_000})])[0]?._meta).toEqual({codex: {phase: "final_answer", turnId: TURN_ID, turnStartedAt: 1_790_000_000_000}});
    });
});
