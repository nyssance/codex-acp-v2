import {expect, it} from "vitest";
import type {ThreadStartParams, ThreadResumeParams, ThreadForkParams} from "../app-server/v2";
import {createTestAgent, THREAD_ID, CWD, model} from "./harness";

it("keeps native identity, removes the proxy on gateway switches and restores it when switching back", async () => {
    const t = createTestAgent();
    try {
        await t.initialize();
        await t.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://foreign.example/v1", _meta: {codex: {id: "foreign", mode: "catalog"}, alwith: {models: [{id: "foreign-model"}]}}});
        await t.openSession();
        const start = t.codex.lastParams<ThreadStartParams>("thread/start");
        expect(start.modelProvider).toBe("openai");
        const local = start.config?.["openai_base_url"];
        expect(local).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}$/);
        await t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "model", type: "id", value: "gateway:foreign:foreign-model"});
        const foreign = t.codex.lastParams<ThreadResumeParams>("thread/resume");
        expect(foreign.modelProvider).toBe("foreign");
        expect(foreign.config?.["openai_base_url"]).toBeUndefined();
        await t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "model", type: "id", value: model().id});
        const native = t.codex.lastParams<ThreadResumeParams>("thread/resume");
        expect(native.modelProvider).toBe("openai");
        expect(native.config?.["openai_base_url"]).toBe(local);
        expect(t.codex.calls("config/value/write")).toHaveLength(0);
    } finally { t.codex.close(); }
});

it("uses a new process-local endpoint on resume and applies it to forks", async () => {
    const first = createTestAgent(); const second = createTestAgent();
    try {
        await first.initialize(); await first.openSession();
        const old = first.codex.lastParams<ThreadStartParams>("thread/start").config?.["openai_base_url"];
        first.codex.close();
        await second.initialize();
        await second.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD, mcpServers: []});
        const resumed = second.codex.lastParams<ThreadResumeParams>("thread/resume");
        expect(resumed.config?.["openai_base_url"]).toMatch(/^http:\/\/127\.0\.0\.1:/);
        expect(resumed.config?.["openai_base_url"]).not.toBe(old);
        await second.agent.forkSession({sessionId: THREAD_ID, cwd: CWD, mcpServers: []});
        expect(second.codex.lastParams<ThreadForkParams>("thread/fork").config?.["openai_base_url"]).toBe(resumed.config?.["openai_base_url"]);
    } finally { first.codex.close(); second.codex.close(); }
});
