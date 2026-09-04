import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {describe, expect, it} from "vitest";
import type {ThreadStartParams, TurnStartParams} from "../app-server/v2";
import {createTestAgent, CWD, expectRejects, itemCompleted, itemStarted, model, thread, threadResponse, THREAD_ID, turn, turnCompleted, TURN_ID} from "./harness";

describe("initialize", () => {
    it("advertises v2 capabilities and auth methods", async () => {
        const t = createTestAgent();
        const response = await t.initialize({elicitation: {url: {}, form: {}}});
        expect(response.protocolVersion).toBe(2);
        expect(response.info.name).toBe("codex-acp-v2-test");
        expect(response.capabilities?.session).toEqual({
            prompt: {image: {}, embeddedContext: {}},
            mcp: {stdio: {}, http: {}},
            fork: {},
            delete: {},
            additionalDirectories: {},
        });
        expect(response.authMethods?.map(method => method.methodId)).toEqual(["api-key", "chat-gpt", "chat-gpt-device-code"]);
        expect(t.codex.lastParams<{clientInfo: {name: string}}>("initialize").clientInfo.name).toBe("test-client");
    });

    it("is idempotent: a re-attached client can initialize again", async () => {
        const t = createTestAgent();
        await t.initialize();
        const again = await t.initialize({elicitation: {form: {}}});
        expect(again.protocolVersion).toBe(2);
        expect(t.codex.calls("initialize")).toHaveLength(1);
    });

    it("omits the device-code method when the client cannot open URLs", async () => {
        const t = createTestAgent({env: {NO_BROWSER: "1"}});
        const response = await t.initialize();
        expect(response.authMethods?.map(method => method.methodId)).toEqual(["api-key"]);
    });

    it("rejects other protocol versions", async () => {
        const t = createTestAgent();
        await expectRejects(t.agent.initialize({protocolVersion: 1, info: {name: "x", version: "1"}}), -32602, "protocol version");
    });

    it("gates every session method behind initialize", async () => {
        const t = createTestAgent();
        await expectRejects(t.agent.newSession({cwd: CWD}), -32600, "initialize");
        await expectRejects(t.agent.prompt({sessionId: "s", prompt: []}), -32600, "initialize");
    });
});

describe("session/new", () => {
    it("starts a Codex thread with trusted roots, extra sandbox roots, and MCP servers", async () => {
        const t = createTestAgent();
        await t.initialize();
        const response = await t.agent.newSession({
            cwd: CWD,
            additionalDirectories: ["/workspace/lib"],
            mcpServers: [
                {type: "stdio", name: "chrome bridge", command: "/usr/bin/bridge", args: ["--x"], env: [{name: "A", value: "1"}]},
                {type: "http", name: "remote", url: "https://mcp.example.com", headers: [{name: "Authorization", value: "Bearer t"}]},
            ],
        });
        expect(response.sessionId).toBe(THREAD_ID);
        const params = t.codex.lastParams<ThreadStartParams>("thread/start");
        expect(params.cwd).toBe(CWD);
        expect(params.config).toMatchObject({
            projects: {[CWD]: {trust_level: "trusted"}, "/workspace/lib": {trust_level: "trusted"}},
            sandbox_workspace_write: {writable_roots: ["/workspace/lib"]},
            mcp_servers: {
                chrome_bridge: {command: "/usr/bin/bridge", args: ["--x"], env: {A: "1"}},
                remote: {url: "https://mcp.example.com", http_headers: {Authorization: "Bearer t"}},
            },
        });
        expect(response.configOptions?.map(option => option.configId)).toEqual(["mode", "model", "effort", "collaboration_mode", "fast_mode"]);
        const modeOption = response.configOptions?.find(option => option.configId === "mode");
        expect(modeOption).toMatchObject({category: "mode", type: "select", currentValue: "agent"});
        const effortOption = response.configOptions?.find(option => option.configId === "effort");
        expect(effortOption).toMatchObject({category: "thought_level", currentValue: "medium"});
    });

    it("skips client MCP servers that collide with user configuration", async () => {
        const t = createTestAgent();
        t.codex.respond("config/read", () => ({config: {mcp_servers: {remote: {url: "x"}}}, origins: {}, layers: []}));
        await t.initialize();
        await t.agent.newSession({cwd: CWD, mcpServers: [{type: "http", name: "remote", url: "https://other"}]});
        const params = t.codex.lastParams<ThreadStartParams>("thread/start");
        expect(params.config?.["mcp_servers"]).toBeUndefined();
    });

    it("publishes available commands including skills after the session opens", async () => {
        const t = createTestAgent();
        t.codex.respond("skills/list", () => ({data: [{cwd: CWD, skills: [{name: "deploy", description: "Deploy", path: "/s", scope: "user", enabled: true, pluginId: null}], errors: []}]}));
        await t.initialize();
        await t.agent.newSession({cwd: CWD});
        await t.settle();
        const commands = t.client.updatesOf("available_commands_update").at(-1)?.availableCommands.map(command => command.name);
        expect(commands).toContain("review");
        expect(commands).toContain("$deploy");
    });

    it("requires authentication and a valid cwd", async () => {
        const t = createTestAgent();
        await t.initialize();
        await expectRejects(t.agent.newSession({cwd: "relative"}), -32602, "absolute");
        t.codex.respond("account/read", () => ({account: null, requiresOpenaiAuth: true}));
        await expectRejects(t.agent.newSession({cwd: CWD}), -32000, "Log in");
    });

    it("reports MCP servers that fail to start as failed tool calls", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.agent.newSession({cwd: CWD, mcpServers: [{type: "stdio", name: "broken", command: "/bin/false"}]});
        t.codex.emit({method: "mcpServer/startupStatus/updated", params: {threadId: THREAD_ID, name: "broken", status: "failed", error: "exit 1", failureReason: null}});
        await t.settle();
        const failure = t.client.updatesOf("tool_call_update").find(update => update.name === "mcp_startup");
        expect(failure).toMatchObject({status: "failed", title: "Start MCP server broken"});
    });
});

describe("session/prompt", () => {
    it("acknowledges immediately, streams the turn, and closes it with idle + usage", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        const response = await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "hello"}], _meta: {alwith: {providerId: "codex"}}});
        expect(response).toEqual({});
        await t.settle();
        expect(t.client.states()).toEqual(["running"]);
        const start = t.codex.lastParams<TurnStartParams>("turn/start");
        expect(start).toMatchObject({
            threadId: THREAD_ID,
            input: [{type: "text", text: "hello", text_elements: []}],
            model: "gpt-5",
            effort: "medium",
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            summary: "auto",
            serviceTier: null,
        });

        itemStarted(t.codex, {type: "agentMessage", id: "msg-1", text: "", phase: "final_answer", memoryCitation: null, delivery: null, questions: null});
        t.codex.emit({method: "item/agentMessage/delta", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "msg-1", delta: "Hi"}});
        t.codex.emit({method: "item/agentMessage/delta", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "msg-1", delta: " there"}});
        t.codex.emit({method: "thread/tokenUsage/updated", params: {threadId: THREAD_ID, turnId: TURN_ID, tokenUsage: {
            total: {totalTokens: 100, inputTokens: 80, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5},
            last: {totalTokens: 100, inputTokens: 80, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5},
            modelContextWindow: 1000,
        }}});
        turnCompleted(t.codex);
        await t.settle();

        const chunks = t.client.updatesOf("agent_message_chunk");
        expect(chunks.map(chunk => (chunk.content as {text: string}).text)).toEqual(["Hi", " there"]);
        expect(chunks[0]).toMatchObject({messageId: "msg-1", _meta: {codex: {phase: "final_answer"}}});
        expect(t.client.updatesOf("usage_update")[0]).toMatchObject({used: 100, size: 1000});
        expect(t.client.updatesOf("session_info_update").at(-1)).toMatchObject({title: "hello"});
        const idle = t.client.updatesOf("state_update").at(-1);
        expect(idle).toMatchObject({
            state: "idle",
            stopReason: "end_turn",
            usage: {totalTokens: 100, inputTokens: 60, outputTokens: 20, thoughtTokens: 5, cachedReadTokens: 20, cachedWriteTokens: 0},
        });
        expect(t.client.states()).toEqual(["running", "idle"]);
    });

    it("surfaces a failed turn as an error message and idle with error metadata", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "go"}]});
        await t.settle();
        turnCompleted(t.codex, {status: "failed", error: {message: "Rate limited", codexErrorInfo: "rateLimitExceeded", additionalDetails: null, misalignment: null}});
        await t.settle();
        const errorChunk = t.client.updatesOf("agent_message_chunk").at(-1);
        expect(errorChunk).toMatchObject({content: {type: "text", text: "Rate limited"}, _meta: {codex: {error: {codexErrorInfo: "rateLimitExceeded"}}}});
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "_error", _meta: {codex: {error: {message: "Rate limited"}}}});
    });

    it("turns a turn/start failure into an error report instead of a hung session", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        t.codex.respond("turn/start", () => {
            throw new Error("boom");
        });
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "go"}]});
        await t.settle();
        expect(t.client.states()).toEqual(["running", "idle"]);
        expect(t.client.updatesOf("agent_message_chunk").at(-1)?.content).toEqual({type: "text", text: "boom"});
        // the session is usable again
        t.codex.respond("turn/start", () => ({turn: turn({status: "inProgress"})}));
        await expect(t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "again"}]})).resolves.toEqual({});
    });

    it("steers the running turn when a second prompt arrives", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "first"}]});
        await t.settle();
        const response = await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "also this"}]});
        expect(response).toEqual({_meta: {codex: {steered: TURN_ID}}});
        expect(t.codex.lastParams<{expectedTurnId: string; input: unknown[]}>("turn/steer")).toMatchObject({expectedTurnId: TURN_ID, input: [{type: "text", text: "also this"}]});
    });

    it("rejects image prompts for text-only models and empty prompts", async () => {
        const t = createTestAgent({catalog: [model({inputModalities: ["text"]})]});
        await t.initialize();
        await t.openSession();
        await expectRejects(t.agent.prompt({sessionId: THREAD_ID, prompt: []}), -32602, "at least one");
        await expectRejects(t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "image", data: "aGk=", mimeType: "image/png"}]}), -32602, "image");
    });

    it("disables reasoning summaries for API-key accounts and honours fast mode", async () => {
        const t = createTestAgent();
        t.codex.respond("account/read", () => ({account: {type: "apiKey"}, requiresOpenaiAuth: true}));
        await t.initialize();
        await t.openSession();
        await t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "fast_mode", type: "boolean", value: true});
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "go"}]});
        await t.settle();
        expect(t.codex.lastParams<TurnStartParams>("turn/start")).toMatchObject({summary: "none", serviceTier: "fast"});
    });
});

describe("session/cancel", () => {
    it("interrupts the turn, cancels open tool calls, and reports idle with stopReason cancelled", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "long task"}]});
        await t.settle();
        itemStarted(t.codex, {type: "commandExecution", id: "c-open", pluginId: null, scriptPath: null, command: "sleep 100", cwd: CWD, processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null});
        itemStarted(t.codex, {type: "commandExecution", id: "c-done", pluginId: null, scriptPath: null, command: "ls", cwd: CWD, processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null});
        itemCompleted(t.codex, {type: "commandExecution", id: "c-done", pluginId: null, scriptPath: null, command: "ls", cwd: CWD, processId: null, source: "agent", status: "completed", commandActions: [], aggregatedOutput: "", exitCode: 0, durationMs: 1});
        await t.settle();
        await t.agent.cancel({sessionId: THREAD_ID});
        expect(t.codex.lastParams<{turnId: string}>("turn/interrupt")).toEqual({threadId: THREAD_ID, turnId: TURN_ID});
        turnCompleted(t.codex, {status: "interrupted"});
        await t.settle();
        expect(t.client.states()).toEqual(["running", "idle"]);
        const updates = t.client.updates();
        const cancelledFrames = updates.filter(update => update.sessionUpdate === "tool_call_update" && (update as {status?: string}).status === "cancelled");
        expect(cancelledFrames.map(update => (update as {toolCallId: string}).toolCallId)).toEqual(["c-open"]);
        expect(updates.indexOf(cancelledFrames[0]!)).toBeLessThan(updates.length - 1);
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "cancelled"});
    });

    it("waits for turn/start before interrupting when cancelled early", async () => {
        const t = createTestAgent();
        let releaseStart: () => void = () => {};
        t.codex.respond("turn/start", () => new Promise(resolve => {
            releaseStart = () => resolve({turn: turn({status: "inProgress"})});
        }));
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "x"}]});
        await t.settle();
        expect(t.codex.calls("turn/start")).toHaveLength(1);
        const cancelled = t.agent.cancel({sessionId: THREAD_ID});
        await t.settle();
        expect(t.codex.calls("turn/interrupt")).toHaveLength(0);
        releaseStart();
        await cancelled;
        expect(t.codex.calls("turn/interrupt")).toHaveLength(1);
        turnCompleted(t.codex, {status: "interrupted"});
        await t.settle();
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "cancelled"});
    });

    it("never starts the turn when cancelled before turn/start is sent", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        // Hold the skills refresh that precedes turn/start so the cancel lands before it.
        let releaseSkills: () => void = () => {};
        t.codex.respond("skills/list", () => new Promise(resolve => {
            releaseSkills = () => resolve({data: []});
        }));
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "x"}]});
        await t.settle();
        const cancelled = t.agent.cancel({sessionId: THREAD_ID});
        releaseSkills();
        await cancelled;
        await t.settle();
        expect(t.codex.calls("turn/start")).toHaveLength(0);
        expect(t.codex.calls("turn/interrupt")).toHaveLength(0);
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "cancelled"});
    });

    it("is a no-op without an active turn", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.cancel({sessionId: THREAD_ID});
        await t.agent.cancel({sessionId: "unknown"});
        expect(t.codex.calls("turn/interrupt")).toHaveLength(0);
    });
});

describe("session/set_config_option", () => {
    it("applies model, effort, mode, and fast mode and broadcasts the option list", async () => {
        const t = createTestAgent({catalog: [model(), model({id: "gpt-5-mini", displayName: "GPT-5 mini", isDefault: false, serviceTiers: [], supportedReasoningEfforts: [{reasoningEffort: "low", description: ""}], defaultReasoningEffort: "low"})]});
        await t.initialize();
        await t.openSession();
        await t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "fast_mode", type: "boolean", value: true});
        const response = await t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "model", type: "id", value: "gpt-5-mini"});
        const byId = Object.fromEntries(response.configOptions.map(option => [option.configId, option]));
        expect(byId["model"]).toMatchObject({currentValue: "gpt-5-mini"});
        expect(byId["effort"]).toMatchObject({currentValue: "low"});
        expect(byId["fast_mode"]).toBeUndefined();
        expect(t.client.updatesOf("config_option_update")).toHaveLength(2);
        await t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "mode", type: "id", value: "read-only"});
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "go"}]});
        await t.settle();
        expect(t.codex.lastParams<TurnStartParams>("turn/start")).toMatchObject({model: "gpt-5-mini", effort: "low", approvalsReviewer: "user", serviceTier: null});
    });

    it("pushes collaboration mode to Codex thread settings", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "collaboration_mode", type: "id", value: "plan"});
        expect(t.codex.lastParams<{collaborationMode: {mode: string}}>("thread/settings/update")).toMatchObject({threadId: THREAD_ID, collaborationMode: {mode: "plan"}});
    });

    it("rejects unknown options and unsupported values", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await expectRejects(t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "nope", type: "id", value: "x"}), -32602, "Unknown config option");
        await expectRejects(t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "effort", type: "id", value: "ultra"}), -32602, "does not support");
        await expectRejects(t.agent.setSessionConfigOption({sessionId: "missing", configId: "mode", type: "id", value: "agent"}), -32602, "Unknown session");
    });
});

describe("resume, fork, list, close, delete", () => {
    const history = [
        {type: "userMessage" as const, id: "u1", clientId: null, content: [{type: "text" as const, text: "make it work", text_elements: []}]},
        {type: "agentMessage" as const, id: "a1", text: "Done.", phase: "final_answer" as const, memoryCitation: null, delivery: null, questions: null},
    ];

    it("replays history before resolving session/resume with replayFrom start", async () => {
        const t = createTestAgent();
        t.codex.respond("thread/turns/list", () => ({data: [turn({items: history})], nextCursor: null, backwardsCursor: null}));
        await t.initialize();
        const response = await t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD, replayFrom: {type: "start"}});
        expect(t.codex.lastParams<{excludeTurns?: boolean}>("thread/resume").excludeTurns).toBe(true);
        expect(response.configOptions?.length).toBeGreaterThan(0);
        expect(t.client.updates().map(update => update.sessionUpdate)).toEqual(["session_info_update", "user_message", "agent_message"]);
        expect(t.client.updatesOf("session_info_update")[0]).toMatchObject({title: "make it work"});
        expect(t.client.updatesOf("user_message")[0]).toMatchObject({messageId: "u1", content: [{type: "text", text: "make it work"}]});
    });

    it("restores context only when replayFrom is null", async () => {
        const t = createTestAgent();
        t.codex.respond("thread/resume", (params) => threadResponse({id: params.threadId, name: "Named"}));
        await t.initialize();
        await t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD, replayFrom: null});
        expect(t.client.updates().map(update => update.sessionUpdate)).toEqual(["session_info_update"]);
        expect(t.client.updatesOf("session_info_update")[0]).toMatchObject({title: "Named"});
        expect(t.codex.calls("thread/turns/list")).toHaveLength(0);
    });

    it("forks into a new session and replays the copied transcript", async () => {
        const t = createTestAgent();
        t.codex.respond("thread/fork", () => threadResponse({id: "thread-fork"}));
        t.codex.respond("thread/turns/list", (params) => ({data: params.threadId === "thread-fork" ? [turn({items: history})] : [], nextCursor: null, backwardsCursor: null}));
        await t.initialize();
        const response = await t.agent.forkSession({sessionId: THREAD_ID, cwd: CWD});
        expect(response.sessionId).toBe("thread-fork");
        expect(t.client.updates().every(update => update.sessionId === "thread-fork")).toBe(true);
        expect(t.client.updatesOf("agent_message")).toHaveLength(1);
    });

    it("streams long histories page by page", async () => {
        const t = createTestAgent();
        const pages: Record<string, {data: ReturnType<typeof turn>[]; nextCursor: string | null}> = {
            first: {data: [turn({id: "t1", items: [history[0]!]})], nextCursor: "c2"},
            c2: {data: [turn({id: "t2", items: [history[1]!]})], nextCursor: null},
        };
        t.codex.respond("thread/turns/list", (params) => ({...pages[params.cursor ?? "first"], backwardsCursor: null}));
        await t.initialize();
        await t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD, replayFrom: {type: "start"}});
        const calls = t.codex.calls("thread/turns/list").map(call => (call.params as {cursor: string | null; limit: number; sortDirection: string}));
        expect(calls.map(call => call.cursor)).toEqual([null, "c2"]);
        expect(calls[0]).toMatchObject({limit: 50, sortDirection: "asc"});
        expect(t.client.updates().map(update => update.sessionUpdate)).toEqual(["session_info_update", "user_message", "agent_message"]);
    });

    it("lists sessions as ACP session info", async () => {
        const t = createTestAgent();
        t.codex.respond("thread/list", () => ({data: [thread({name: "Alpha"}), thread({id: "t2", preview: "second prompt"})], nextCursor: "c2", backwardsCursor: null}));
        await t.initialize();
        const response = await t.agent.listSessions({cwd: CWD});
        expect(response.sessions).toEqual([
            {sessionId: THREAD_ID, cwd: CWD, title: "Alpha", updatedAt: new Date(1_700_000_100 * 1000).toISOString()},
            {sessionId: "t2", cwd: CWD, title: "second prompt", updatedAt: new Date(1_700_000_100 * 1000).toISOString()},
        ]);
        expect(response.nextCursor).toBe("c2");
        expect(t.codex.lastParams<{cwd: string}>("thread/list").cwd).toBe(CWD);
    });

    it("close interrupts an active turn, waits for it, and unsubscribes", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "x"}]});
        await t.settle();
        t.codex.respond("turn/interrupt", () => {
            setTimeout(() => turnCompleted(t.codex, {status: "interrupted"}), 0);
            return {};
        });
        await t.agent.closeSession({sessionId: THREAD_ID});
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "cancelled"});
        expect(t.codex.calls("thread/unsubscribe")).toHaveLength(1);
        await expectRejects(t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "x"}]}), -32602, "Unknown session");
    });

    it("delete closes and archives the thread", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.deleteSession({sessionId: THREAD_ID});
        expect(t.codex.calls("thread/unsubscribe")).toHaveLength(1);
        expect(t.codex.lastParams<{threadId: string}>("thread/archive")).toEqual({threadId: THREAD_ID});
    });
});

describe("auth", () => {
    it("logs in with an API key from the environment", async () => {
        const t = createTestAgent({env: {CODEX_API_KEY: "sk-test"}});
        t.codex.respond("account/login/start", () => {
            setTimeout(() => t.codex.emit({method: "account/login/completed", params: {loginId: null, success: true, error: null, onboardingEntrypoint: null}}), 0);
            return {type: "apiKey"};
        });
        await t.initialize();
        await expect(t.agent.login({methodId: "api-key"})).resolves.toEqual({});
        expect(t.codex.lastParams<{type: string; apiKey: string}>("account/login/start")).toEqual({type: "apiKey", apiKey: "sk-test"});
    });

    it("reports a missing API key as invalid params and unknown methods explicitly", async () => {
        const t = createTestAgent();
        await t.initialize();
        await expectRejects(t.agent.login({methodId: "api-key"}), -32602, "No API key");
        await expectRejects(t.agent.login({methodId: "magic"}), -32602, "Unknown auth method");
    });

    it("logs out and refreshes the account on open sessions", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        t.codex.respond("account/logout", () => {
            setTimeout(() => t.codex.emit({method: "account/updated", params: {authMode: null, planType: null}}), 0);
            return {};
        });
        t.codex.respond("account/read", () => ({account: null, requiresOpenaiAuth: true}));
        await expect(t.agent.logout({})).resolves.toEqual({});
        expect(t.codex.calls("account/logout")).toHaveLength(1);
    });
});

describe("slash commands", () => {
    it("answers /status locally without starting a turn", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/status"}]});
        await t.settle();
        expect(t.codex.calls("turn/start")).toHaveLength(0);
        const text = (t.client.updatesOf("agent_message_chunk")[0]?.content as {text: string}).text;
        expect(text).toContain("**Model:** gpt-5 (medium)");
        expect(t.client.states()).toEqual(["running", "idle"]);
    });

    it("toggles plan mode with /plan", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/plan"}]});
        await t.settle();
        expect(t.codex.lastParams<{collaborationMode: {mode: string}}>("thread/settings/update").collaborationMode.mode).toBe("plan");
        expect(t.client.updatesOf("config_option_update").at(-1)?.configOptions.find(option => option.configId === "collaboration_mode")).toMatchObject({currentValue: "plan"});
    });

    it("runs /compact and waits for the compaction item", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        t.codex.respond("thread/compact/start", () => {
            setTimeout(() => itemCompleted(t.codex, {type: "contextCompaction", id: "c1"}), 0);
            return {};
        });
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/compact"}]});
        await t.settle();
        expect(t.client.updatesOf("compaction_update").at(-1)).toMatchObject({sessionUpdate: "compaction_update", compactionId: "c1", status: "completed"});
        expect(t.client.states()).toEqual(["running", "idle"]);
    });

    it("passes unknown slash commands to Codex as prompts", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/mystery do it"}]});
        await t.settle();
        expect(t.codex.lastParams<TurnStartParams>("turn/start").input).toEqual([{type: "text", text: "/mystery do it", text_elements: []}]);
    });
});

describe("plan mode", () => {
    it("asks to implement a completed plan and runs the implementation turn on approval", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.setSessionConfigOption({sessionId: THREAD_ID, configId: "collaboration_mode", type: "id", value: "plan"});
        t.client.clear();
        t.client.permissionResponder = () => ({outcome: {outcome: "selected", optionId: "implement_plan"}});
        let starts = 0;
        t.codex.respond("turn/start", () => ({turn: turn({id: `turn-${++starts}`, status: "inProgress"})}));
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "plan it"}]});
        await t.settle();
        itemCompleted(t.codex, {type: "plan", id: "plan-1", text: "1. do x"}, "turn-1");
        t.codex.emit({method: "turn/completed", params: {threadId: THREAD_ID, turn: turn({id: "turn-1"})}});
        await t.settle();
        const request = t.client.permissionRequests()[0];
        expect(request).toMatchObject({title: "Implement this plan?", subject: {type: "tool_call", toolCall: {kind: "switch_mode", rawInput: {plan: "1. do x"}}}});
        expect(t.client.updatesOf("plan_update")[0]).toMatchObject({plan: {type: "markdown", planId: "plan-1", content: "1. do x"}});
        expect(starts).toBe(2);
        expect(t.codex.lastParams<TurnStartParams>("turn/start").input).toEqual([{type: "text", text: "Implement the approved plan.", text_elements: []}]);
        t.codex.emit({method: "turn/completed", params: {threadId: THREAD_ID, turn: turn({id: "turn-2"})}});
        await t.settle();
        expect(t.client.states()).toEqual(["running", "requires_action", "running", "idle"]);
        expect(t.client.updatesOf("config_option_update").at(-1)?.configOptions.find(option => option.configId === "collaboration_mode")).toMatchObject({currentValue: "default"});
    });
});

describe("codex process loss", () => {
    it("fails the active turn with a connection error", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "x"}]});
        await t.settle();
        t.codex.close();
        await t.settle();
        expect(t.client.updatesOf("agent_message_chunk").at(-1)?.content).toEqual({type: "text", text: "Connection to Codex was lost"});
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "_error"});
    });
});

describe("history mapping", () => {
    it("replays tool calls, terminals, and reasoning from a loaded thread", async () => {
        const t = createTestAgent();
        t.codex.respond("thread/turns/list", () => ({
            nextCursor: null,
            backwardsCursor: null,
            data: [turn({items: [
                {type: "reasoning", id: "r1", summary: ["thinking"], content: []},
                {type: "commandExecution", id: "c1", pluginId: null, scriptPath: null, command: "ls", cwd: CWD, processId: null, source: "agent", status: "completed", commandActions: [], aggregatedOutput: "a\nb\n", exitCode: 0, durationMs: 3},
                {type: "fileChange", id: "f1", changes: [{path: `${CWD}/a.txt`, kind: {type: "add"}, diff: "hello\n"}], status: "completed"},
            ]})],
        }));
        await t.initialize();
        await t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD, replayFrom: {type: "start"}});
        const kinds = t.client.updates().map(update => update.sessionUpdate);
        expect(kinds).toEqual(["agent_thought", "tool_call_update", "terminal_update", "tool_call_update", "tool_call_update"]);
        expect(t.client.updatesOf("terminal_update")[0]).toMatchObject({terminalId: "c1", command: "ls", output: {data: Buffer.from("a\nb\n").toString("base64")}, exitStatus: {exitCode: 0}});
        expect(t.client.updatesOf("tool_call_update").at(-1)).toMatchObject({toolCallId: "f1", name: "apply_patch", status: "completed", content: [{type: "diff", changes: [{operation: "add", path: `${CWD}/a.txt`}]}]});
    });
});

describe("providers", () => {
    const gateway = {providerId: "openai", apiType: "openai" as const, baseUrl: "https://gw.example.com/v1", headers: {authorization: "Bearer k"}};

    it("advertises the providers capability and lists the OpenAI slot", async () => {
        const t = createTestAgent();
        const init = await t.initialize();
        expect(init.capabilities?.providers).toEqual({});
        expect(t.agent.listProviders({})).toEqual({
            providers: [{providerId: "openai", supported: ["openai"], required: false, current: {apiType: "openai", baseUrl: "https://api.openai.com/v1"}}],
        });
    });

    it("routes new threads through the gateway and skips the OpenAI login check", async () => {
        const t = createTestAgent();
        t.codex.respond("account/read", () => ({account: null, requiresOpenaiAuth: true}));
        await t.initialize();
        await t.agent.setProvider({...gateway, _meta: {codex: {name: "My gateway"}}});
        expect(t.agent.listProviders({}).providers[0]?.current).toEqual({apiType: "openai", baseUrl: "https://gw.example.com/v1"});
        await t.agent.newSession({cwd: CWD});
        const params = t.codex.lastParams<ThreadStartParams>("thread/start");
        expect(params.modelProvider).toBe("custom-gateway");
        expect(params.config?.["model_providers"]).toEqual({
            "custom-gateway": {
                name: "My gateway",
                base_url: "https://gw.example.com/v1",
                wire_api: "responses",
                http_headers: {"X-Client-Feature-ID": "codex", authorization: "Bearer k"},
            },
        });
    });

    it("uses the client's model catalog and selected model when provided", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.agent.setProvider({...gateway, _meta: {alwith: {model: "deepseek-chat", models: [{id: "deepseek-chat", label: "DeepSeek"}, {id: "deepseek-reasoner"}]}}});
        const response = await t.agent.newSession({cwd: CWD});
        const modelOption = response.configOptions?.find(option => option.configId === "model") as {currentValue: string; options: Array<{value: string; name: string}>};
        expect(modelOption.currentValue).toBe("deepseek-chat");
        expect(modelOption.options.map(option => [option.value, option.name])).toEqual([["deepseek-chat", "DeepSeek"], ["deepseek-reasoner", "deepseek-reasoner"]]);
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "hi"}]});
        await t.settle();
        expect(t.codex.lastParams<TurnStartParams>("turn/start").model).toBe("deepseek-chat");
    });

    it("rebinds open sessions in place and broadcasts their options", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.setProvider(gateway);
        const resume = t.codex.lastParams<{threadId: string; modelProvider: string | null; excludeTurns?: boolean; config?: Record<string, unknown>}>("thread/resume");
        expect(resume).toMatchObject({threadId: THREAD_ID, modelProvider: "custom-gateway", excludeTurns: true});
        expect(resume.config?.["model_providers"]).toBeDefined();
        expect(t.client.updatesOf("config_option_update")).toHaveLength(1);
        await t.agent.disableProvider({providerId: "openai"});
        expect(t.codex.lastParams<{modelProvider: string | null}>("thread/resume").modelProvider).toBeNull();
        expect(t.agent.listProviders({}).providers[0]?.current?.baseUrl).toBe("https://api.openai.com/v1");
    });

    it("refuses to switch routing while a turn is running", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "go"}]});
        await t.settle();
        await expectRejects(t.agent.setProvider(gateway), -32600, "turn is running");
        expect(t.codex.calls("thread/resume")).toHaveLength(0);
    });

    it("validates provider requests", async () => {
        const t = createTestAgent();
        await t.initialize();
        await expectRejects(t.agent.setProvider({...gateway, providerId: "anthropic"}), -32602, "Unknown providerId");
        await expectRejects(t.agent.setProvider({...gateway, apiType: "anthropic"}), -32602, "OpenAI protocol");
        await expectRejects(t.agent.setProvider({...gateway, baseUrl: "not a url"}), -32602, "http(s)");
        await expect(t.agent.disableProvider({providerId: "whatever"})).resolves.toEqual({});
    });
});

it("exports the v2 SDK protocol version the agent speaks", () => {
    expect(acp.PROTOCOL_VERSION).toBe(2);
});

describe("remaining commands", () => {
    it("runs /review inline and ends the turn from the review completion", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/review focus on tests"}]});
        await t.settle();
        expect(t.codex.lastParams<{target: unknown; delivery: string}>("review/start")).toMatchObject({threadId: THREAD_ID, target: {type: "custom", instructions: "focus on tests"}, delivery: "inline"});
        expect(t.codex.calls("turn/start")).toHaveLength(0);
        t.codex.emit({method: "turn/completed", params: {threadId: THREAD_ID, turn: turn({id: "review-turn"})}});
        await t.settle();
        expect(t.client.states()).toEqual(["running", "idle"]);
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "end_turn"});
    });

    it("answers /mcp and /skills from Codex and /logout through the account", async () => {
        const t = createTestAgent();
        t.codex.respond("mcpServerStatus/list", () => ({data: [{name: "srv", runtimeStatus: null, pluginId: null, serverInfo: null, tools: {a: {}, b: {}}, resources: [], resourceTemplates: [], authStatus: "unsupported"}], nextCursor: null}));
        t.codex.respond("skills/list", () => ({data: [{cwd: CWD, skills: [{name: "deploy", description: "Ship it", path: "/s", scope: "user", enabled: true, pluginId: null}], errors: []}]}));
        t.codex.respond("account/logout", () => {
            setTimeout(() => t.codex.emit({method: "account/updated", params: {authMode: null, planType: null}}), 0);
            return {};
        });
        await t.initialize();
        await t.agent.newSession({cwd: CWD, mcpServers: [{type: "stdio", name: "local tool", command: "/bin/tool"}]});
        await t.settle();
        for (const command of ["/mcp", "/skills", "/logout"]) {
            t.client.clear();
            await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: command}]});
            await t.settle();
            expect(t.client.states()).toEqual(["running", "idle"]);
        }
        const texts = () => t.client.updatesOf("agent_message_chunk").map(chunk => (chunk.content as {text: string}).text);
        expect(texts().at(-1)).toBe("Logged out of the Codex account.");
        expect(t.codex.calls("account/logout")).toHaveLength(1);
        t.client.clear();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/mcp"}]});
        await t.settle();
        expect(texts()[0]).toContain("- srv: 2 tools, 0 resources, auth=unsupported");
        expect(texts()[0]).toContain("- local_tool");
        t.client.clear();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/skills"}]});
        await t.settle();
        expect(texts()[0]).toBe("Available skills:\n- deploy: Ship it");
    });

    it("shows rate limits in /status once Codex reports them", async () => {
        const t = createTestAgent();
        await t.initialize();
        await t.openSession();
        t.codex.emit({method: "account/rateLimits/updated", params: {rateLimits: {limitId: "weekly", limitName: "Weekly", primary: {usedPercent: 40, windowDurationMins: 10080, resetsAt: null}, secondary: null, credits: {hasCredits: true, unlimited: true, balance: null}, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null}}});
        await t.settle();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/status"}]});
        await t.settle();
        const text = (t.client.updatesOf("agent_message_chunk")[0]?.content as {text: string}).text;
        expect(text).toContain("**Weekly Weekly limit:** 60% left");
        expect(text).toContain("**Weekly Credits:** unlimited");
    });
});

describe("edge paths", () => {
    it("fails steering with a clear error when Codex rejects it", async () => {
        const t = createTestAgent();
        t.codex.respond("turn/steer", () => {
            throw new Error("turn not steerable");
        });
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "first"}]});
        await t.settle();
        await expectRejects(t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "second"}]}), -32600, "Could not steer");
    });

    it("close synthesizes the turn end when Codex never answers the interrupt", async () => {
        const t = createTestAgent({closeGraceMs: 50});
        await t.initialize();
        await t.openSession();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "stuck"}]});
        await t.settle();
        await t.agent.closeSession({sessionId: THREAD_ID});
        expect(t.codex.calls("turn/interrupt")).toHaveLength(1);
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "cancelled"});
        expect(t.codex.calls("thread/unsubscribe")).toHaveLength(1);
    });

    it("pages session/list with the client's cursor", async () => {
        const t = createTestAgent();
        t.codex.respond("thread/list", (params) => ({data: params.cursor === "p2" ? [thread({id: "t2"})] : [thread()], nextCursor: params.cursor === "p2" ? null : "p2", backwardsCursor: null}));
        await t.initialize();
        const first = await t.agent.listSessions({});
        expect(first.nextCursor).toBe("p2");
        const second = await t.agent.listSessions({cursor: "p2"});
        expect(second.sessions.map(session => session.sessionId)).toEqual(["t2"]);
        expect(second.nextCursor).toBeNull();
        expect(t.codex.lastParams<{cwd?: string}>("thread/list").cwd).toBeUndefined();
    });

    it("logs in with a device code through a URL elicitation", async () => {
        const t = createTestAgent();
        t.codex.respond("account/read", () => ({account: null, requiresOpenaiAuth: true}));
        t.codex.respond("account/login/start", () => {
            setTimeout(() => t.codex.emit({method: "account/login/completed", params: {loginId: "login-1", success: true, error: null, onboardingEntrypoint: null}}), 20);
            return {type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.example/device", userCode: "ABCD-1234"};
        });
        t.client.elicitationResponder = () => ({action: "accept"});
        await t.initialize({elicitation: {url: {}}});
        await expect(t.agent.login({methodId: "chat-gpt-device-code"}, 7)).resolves.toEqual({});
        const elicitation = t.client.requests.find(entry => entry.method === acp.methods.client.elicitation.create)?.params as {mode: string; requestId: unknown; url: string; message: string; elicitationId: string};
        expect(elicitation).toMatchObject({mode: "url", requestId: 7, url: "https://auth.example/device", elicitationId: "login-1"});
        expect(elicitation.message).toContain("ABCD-1234");
        expect(t.client.notifications.find(entry => entry.method === acp.methods.client.elicitation.complete)?.params).toEqual({elicitationId: "login-1"});
    });

    it("cancels the device code login when the user declines the URL", async () => {
        const t = createTestAgent();
        t.codex.respond("account/read", () => ({account: null, requiresOpenaiAuth: true}));
        t.codex.respond("account/login/start", () => ({type: "chatgptDeviceCode", loginId: "login-2", verificationUrl: "https://auth.example/device", userCode: "X"}));
        t.client.elicitationResponder = () => ({action: "decline"});
        await t.initialize({elicitation: {url: {}}});
        await expectRejects(t.agent.login({methodId: "chat-gpt-device-code"}), -32000, "cancelled");
        expect(t.codex.lastParams<{loginId: string}>("account/login/cancel")).toEqual({loginId: "login-2"});
    });

    it("skips the browser flow when Codex already has a ChatGPT account", async () => {
        const t = createTestAgent();
        await t.initialize();
        await expect(t.agent.login({methodId: "chat-gpt"})).resolves.toEqual({});
        expect(t.codex.calls("account/login/start")).toHaveLength(0);
    });
});

describe("history inputs", () => {
    it("renders images, mentions, and in-progress commands from history", async () => {
        const t = createTestAgent();
        t.codex.respond("thread/turns/list", () => ({nextCursor: null, backwardsCursor: null, data: [turn({items: [
            {type: "userMessage", id: "u1", clientId: null, content: [
                {type: "text", text: "look at", text_elements: []},
                {type: "localImage", path: "/p/shot.png"},
                {type: "mention", name: "README", path: "/p/README.md"},
                {type: "skill", name: "deploy", path: "/s/deploy"},
            ]},
            {type: "commandExecution", id: "c1", pluginId: null, scriptPath: null, command: "sleep 9", cwd: CWD, processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null},
            {type: "webSearch", id: "w1", query: "acp", action: null, results: null},
        ]})]}));
        await t.initialize();
        await t.agent.resumeSession({sessionId: THREAD_ID, cwd: CWD, replayFrom: {type: "start"}});
        const user = t.client.updatesOf("user_message")[0];
        expect(user?.content?.map(block => (block as {text: string}).text)).toEqual([
            "look at",
            "[@shot.png](file:///p/shot.png)",
            "[@README](file:///p/README.md)",
            "skill:deploy (/s/deploy)",
        ]);
        const kinds = t.client.updates().map(update => update.sessionUpdate);
        expect(kinds).toEqual(["session_info_update", "user_message", "tool_call_update", "terminal_update", "tool_call_update"]);
        expect(t.client.updatesOf("terminal_update")[0]).not.toHaveProperty("exitStatus");
        expect(t.client.updatesOf("tool_call_update").at(-1)).toMatchObject({name: "web_search", title: "Web search: acp", status: "completed"});
    });
});
