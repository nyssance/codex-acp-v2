import {describe, expect, it} from "vitest";
import {createTestAgent, CWD, itemCompleted, itemStarted, THREAD_ID, TURN_ID} from "./harness";

async function openPrompting() {
    const t = createTestAgent();
    await t.initialize();
    await t.openSession();
    await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "go"}]});
    await t.settle();
    t.client.clear();
    return t;
}

describe("command execution", () => {
    it("streams shell commands through an ACP terminal", async () => {
        const t = await openPrompting();
        const item = {type: "commandExecution" as const, id: "c1", pluginId: null, scriptPath: null, command: "/bin/zsh -lc 'ls -la'", cwd: CWD, processId: null, source: "agent" as const, status: "inProgress" as const, commandActions: [{type: "unknown" as const, command: "ls -la"}], aggregatedOutput: null, exitCode: null, durationMs: null};
        itemStarted(t.codex, item);
        t.codex.emit({method: "item/commandExecution/outputDelta", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "c1", delta: "file\n"}});
        itemCompleted(t.codex, {...item, status: "completed", aggregatedOutput: "file\n", exitCode: 0, durationMs: 12});
        await t.settle();
        const updates = t.client.updates();
        expect(updates.map(update => update.sessionUpdate)).toEqual(["tool_call_update", "terminal_update", "terminal_output_chunk", "terminal_update", "tool_call_update"]);
        expect(updates[0]).toMatchObject({name: "shell", title: "ls -la", kind: "execute", status: "in_progress", content: [{type: "terminal", terminalId: "c1"}], rawInput: {command: "/bin/zsh -lc 'ls -la'", cwd: CWD}});
        expect(updates[1]).toMatchObject({terminalId: "c1", command: "/bin/zsh -lc 'ls -la'", cwd: CWD});
        expect(updates[2]).toMatchObject({terminalId: "c1", data: Buffer.from("file\n").toString("base64")});
        expect(updates[3]).toMatchObject({terminalId: "c1", exitStatus: {exitCode: 0, signal: null}, output: {data: Buffer.from("file\n").toString("base64")}});
        expect(updates[4]).toMatchObject({toolCallId: "c1", status: "completed", rawOutput: {output: "file\n", exitCode: 0, durationMs: 12}});
        expect((updates[4] as {name?: string}).name).toBeUndefined();
    });

    it("renders classified commands as read and search tool calls without a terminal", async () => {
        const t = await openPrompting();
        const read = {type: "commandExecution" as const, id: "c2", pluginId: null, scriptPath: null, command: "cat a.txt", cwd: CWD, processId: null, source: "agent" as const, status: "completed" as const, commandActions: [{type: "read" as const, command: "cat a.txt", name: "a.txt", path: `${CWD}/a.txt`}], aggregatedOutput: "content", exitCode: 0, durationMs: 1};
        itemStarted(t.codex, read);
        itemCompleted(t.codex, read);
        const search = {...read, id: "c3", commandActions: [{type: "search" as const, command: "rg foo", query: "foo", path: "src"}]};
        itemStarted(t.codex, search);
        await t.settle();
        const updates = t.client.updatesOf("tool_call_update");
        expect(updates[0]).toMatchObject({name: "read_file", kind: "read", title: `Read ${CWD}/a.txt`, locations: [{path: `${CWD}/a.txt`}]});
        expect(updates[1]).toMatchObject({toolCallId: "c2", status: "completed", content: [{type: "content", content: {type: "text", text: "content"}}]});
        expect(updates[2]).toMatchObject({name: "search", kind: "search", title: "Search for 'foo' in src"});
        expect(t.client.updatesOf("terminal_update")).toHaveLength(0);
    });
});

describe("file changes", () => {
    it("emits v2 diff content with git patches and locations", async () => {
        const t = await openPrompting();
        const item = {
            type: "fileChange" as const,
            id: "f1",
            status: "inProgress" as const,
            changes: [
                {path: `${CWD}/new.txt`, kind: {type: "add" as const}, diff: "line\n"},
                {path: `${CWD}/old.txt`, kind: {type: "delete" as const}, diff: "gone\n"},
                {path: `${CWD}/mod.txt`, kind: {type: "update" as const, move_path: null}, diff: "@@ -1,1 +1,1 @@\n-a\n+b\n"},
            ],
        };
        itemStarted(t.codex, item);
        itemCompleted(t.codex, {...item, status: "completed"});
        await t.settle();
        const [started, completed] = t.client.updatesOf("tool_call_update");
        expect(started).toMatchObject({name: "apply_patch", kind: "edit", title: "Edit 3 files", status: "in_progress"});
        expect(started?.locations?.map(location => location.path)).toEqual([`${CWD}/new.txt`, `${CWD}/old.txt`, `${CWD}/mod.txt`]);
        const diffs = started?.content as Array<{changes: unknown; patch: {format: string; text: string}}>;
        expect(diffs[0]).toMatchObject({changes: [{operation: "add", path: `${CWD}/new.txt`}], patch: {format: "git_patch"}});
        expect(diffs[0]?.patch.text).toBe(`--- /dev/null\n+++ ${CWD}/new.txt\n@@ -1,0 +1,1 @@\n+line\n`);
        expect(diffs[1]?.patch.text).toBe(`--- ${CWD}/old.txt\n+++ /dev/null\n@@ -1,1 +1,0 @@\n-gone\n`);
        expect(diffs[2]?.patch.text).toBe(`--- ${CWD}/mod.txt\n+++ ${CWD}/mod.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n`);
        expect(completed).toMatchObject({toolCallId: "f1", status: "completed"});
    });

    it("represents renames as move changes", async () => {
        const t = await openPrompting();
        itemStarted(t.codex, {type: "fileChange", id: "f2", status: "inProgress", changes: [{path: `${CWD}/a.txt`, kind: {type: "update", move_path: `${CWD}/b.txt`}, diff: "@@ -1 +1 @@\n-x\n+y\n\n\nMoved to: b.txt"}]});
        await t.settle();
        const content = t.client.updatesOf("tool_call_update")[0]?.content?.[0] as {changes: unknown[]; patch: {text: string}};
        expect(content.changes).toEqual([{operation: "move", oldPath: `${CWD}/a.txt`, path: `${CWD}/b.txt`}]);
        expect(content.patch.text).not.toContain("Moved to");
    });
});

describe("messages and reasoning", () => {
    it("keys thought chunks by item and skips completed reasoning that already streamed", async () => {
        const t = await openPrompting();
        t.codex.emit({method: "item/reasoning/summaryTextDelta", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "r1", delta: "think", summaryIndex: 0}});
        t.codex.emit({method: "item/reasoning/summaryPartAdded", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "r1", summaryIndex: 1}});
        itemCompleted(t.codex, {type: "reasoning", id: "r1", summary: ["think", "more"], content: []});
        itemCompleted(t.codex, {type: "reasoning", id: "r2", summary: ["late"], content: []});
        await t.settle();
        const thoughts = t.client.updatesOf("agent_thought_chunk");
        expect(thoughts.map(chunk => [chunk.messageId, (chunk.content as {text: string}).text])).toEqual([["r1", "think"], ["r1", "\n\n"], ["r2", "late"]]);
    });

    it("turns warnings and reroutes into notice chunks", async () => {
        const t = await openPrompting();
        t.codex.emit({method: "warning", params: {threadId: THREAD_ID, message: "disk almost full"}});
        t.codex.emit({method: "model/rerouted", params: {threadId: THREAD_ID, turnId: TURN_ID, fromModel: "a", toModel: "b", reason: "highRiskCyberActivity"}});
        await t.settle();
        const chunks = t.client.updatesOf("agent_message_chunk");
        expect(chunks[0]).toMatchObject({content: {text: "Warning: disk almost full\n\n"}, _meta: {codex: {notice: true}}});
        expect((chunks[1]?.content as {text: string}).text).toContain("Model rerouted from a to b");
    });

    it("publishes thread names as explicit titles", async () => {
        const t = await openPrompting();
        t.codex.emit({method: "thread/name/updated", params: {threadId: THREAD_ID, threadName: "Fix the build"}});
        await t.settle();
        expect(t.client.updatesOf("session_info_update")[0]).toEqual({sessionId: THREAD_ID, sessionUpdate: "session_info_update", title: "Fix the build"});
    });
});

describe("plans", () => {
    it("maps turn plans to item plans and streams markdown plan deltas", async () => {
        const t = await openPrompting();
        t.codex.emit({method: "turn/plan/updated", params: {threadId: THREAD_ID, turnId: TURN_ID, explanation: null, plan: [{step: "a", status: "completed"}, {step: "b", status: "inProgress"}, {step: "c", status: "pending"}]}});
        t.codex.emit({method: "item/plan/delta", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "p1", delta: "# Plan\n"}});
        t.codex.emit({method: "item/plan/delta", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "p1", delta: "- step"}});
        await new Promise(resolve => setTimeout(resolve, 200));
        await t.settle();
        const plans = t.client.updatesOf("plan_update");
        expect(plans[0]?.plan).toEqual({type: "items", planId: "codex-turn-plan", entries: [
            {content: "a", priority: "medium", status: "completed"},
            {content: "b", priority: "medium", status: "in_progress"},
            {content: "c", priority: "medium", status: "pending"},
        ]});
        expect(plans[1]?.plan).toEqual({type: "markdown", planId: "p1", content: "# Plan\n- step"});
    });
});

describe("other tools", () => {
    it("maps MCP, web search, image, compaction, and subagent items", async () => {
        const t = await openPrompting();
        const mcp = {type: "mcpToolCall" as const, id: "m1", server: "srv", tool: "lookup", status: "inProgress" as const, arguments: {q: 1}, appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null};
        itemStarted(t.codex, mcp);
        t.codex.emit({method: "item/mcpToolCall/progress", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "m1", message: " 50% "}});
        itemCompleted(t.codex, {...mcp, status: "failed", error: {message: "nope"}});
        itemStarted(t.codex, {type: "webSearch", id: "w1", query: "acp", action: {type: "search", query: "acp spec", queries: null}, results: null});
        itemCompleted(t.codex, {type: "webSearch", id: "w1", query: "acp", action: {type: "openPage", url: "https://x"}, results: [{url: "https://x"}]});
        itemStarted(t.codex, {type: "imageView", id: "i1", path: "/tmp/pic.png"});
        itemStarted(t.codex, {type: "contextCompaction", id: "k1"});
        itemCompleted(t.codex, {type: "contextCompaction", id: "k1"});
        itemStarted(t.codex, {type: "subAgentActivity", id: "s1", kind: "started", agentThreadId: "t9", agentPath: "root/worker"});
        itemCompleted(t.codex, {type: "subAgentActivity", id: "s1", kind: "started", agentThreadId: "t9", agentPath: "root/worker"});
        await t.settle();
        const updates = t.client.updatesOf("tool_call_update");
        expect(updates[0]).toMatchObject({name: "mcp", title: "srv.lookup", kind: "execute", rawInput: {server: "srv", tool: "lookup", arguments: {q: 1}}});
        expect(updates[1]).toMatchObject({toolCallId: "m1", content: [{type: "content", content: {type: "text", text: "50%"}}]});
        expect(updates[2]).toMatchObject({toolCallId: "m1", status: "failed", rawOutput: {error: {message: "nope"}}});
        expect(updates[3]).toMatchObject({name: "web_search", kind: "fetch", title: "Web search: acp spec", status: "in_progress"});
        expect(updates[4]).toMatchObject({toolCallId: "w1", title: "Open page: https://x", status: "completed", rawOutput: {results: [{url: "https://x"}]}});
        expect(updates[5]).toMatchObject({name: "view_image", kind: "read", status: "completed", locations: [{path: "/tmp/pic.png"}]});
        expect(updates[6]).toMatchObject({name: "subagent", title: "Start subagent worker", status: "in_progress"});
        expect(updates[7]).toMatchObject({toolCallId: "s1", status: "completed"});
        expect((updates[7] as {name?: string}).name).toBeUndefined();
        // compaction is its own ACP v2 update, not a tool call
        expect(t.client.updatesOf("compaction_update")).toMatchObject([
            {sessionUpdate: "compaction_update", compactionId: "k1", status: "in_progress"},
            {sessionUpdate: "compaction_update", compactionId: "k1", status: "completed"},
        ]);
    });

    it("reports where the user message landed when Codex materializes it", async () => {
        const t = await openPrompting();
        itemStarted(t.codex, {type: "userMessage", id: "u1", clientId: null, content: [{type: "text", text: "make it work", text_elements: []}]});
        itemCompleted(t.codex, {type: "userMessage", id: "u1", clientId: null, content: [{type: "text", text: "make it work", text_elements: []}]});
        await t.settle();
        expect(t.client.updatesOf("user_message")).toMatchObject([
            {sessionUpdate: "user_message", messageId: "u1", content: [{type: "text", text: "make it work"}]},
        ]);
    });

    it("ignores notifications for other threads", async () => {
        const t = await openPrompting();
        t.codex.emit({method: "item/agentMessage/delta", params: {threadId: "other", turnId: TURN_ID, itemId: "x", delta: "nope"}});
        await t.settle();
        expect(t.client.updates()).toHaveLength(0);
    });
});

describe("remaining item and notification mappings", () => {
    it("maps dynamic tool calls, image generation, and collab calls", async () => {
        const t = await openPrompting();
        const dynamic = {type: "dynamicToolCall" as const, id: "d1", namespace: "ns", tool: "lint", arguments: {file: "a"}, status: "inProgress" as const, contentItems: null, success: null, durationMs: null};
        itemStarted(t.codex, dynamic);
        itemCompleted(t.codex, {...dynamic, status: "completed", success: true, contentItems: [{type: "inputText", text: "ok"}], durationMs: 5});
        const image = {type: "imageGeneration" as const, id: "g1", status: "generating", revisedPrompt: null, result: "", failure: null};
        itemStarted(t.codex, image);
        itemCompleted(t.codex, {...image, status: "completed", revisedPrompt: "a cat", result: "QUJD", savedPath: "/tmp/cat.png"});
        itemCompleted(t.codex, {type: "imageGeneration", id: "g2", status: "failed", revisedPrompt: null, result: "", failure: {reason: "policy"} as never});
        const collab = {type: "collabAgentToolCall" as const, id: "k1", tool: "spawnAgent" as const, status: "inProgress" as const, senderThreadId: THREAD_ID, receiverThreadIds: ["t2"], prompt: "help", model: null, reasoningEffort: null, agentsStates: {}};
        itemStarted(t.codex, collab);
        itemCompleted(t.codex, {...collab, status: "interrupted"});
        await t.settle();
        const updates = t.client.updatesOf("tool_call_update");
        expect(updates[0]).toMatchObject({name: "dynamic_tool", title: "ns.lint", kind: "execute", status: "in_progress", rawInput: {tool: "lint", namespace: "ns", arguments: {file: "a"}}});
        expect(updates[1]).toMatchObject({toolCallId: "d1", status: "completed", rawOutput: {success: true, durationMs: 5}});
        expect(updates[2]).toMatchObject({name: "image_generation", kind: "other", status: "in_progress"});
        expect(updates[3]).toMatchObject({toolCallId: "g1", status: "completed", content: [
            {type: "content", content: {type: "text", text: "Revised prompt: a cat"}},
            {type: "content", content: {type: "image", data: "QUJD", mimeType: "image/png", uri: "/tmp/cat.png"}},
        ]});
        expect(updates[4]).toMatchObject({toolCallId: "g2", name: "image_generation", status: "failed"});
        expect(updates[5]).toMatchObject({name: "collab", title: "spawnAgent", status: "in_progress", _meta: {codex: {collaboration: {tool: "spawnAgent", receiverThreadIds: ["t2"]}}}});
        expect(updates[6]).toMatchObject({toolCallId: "k1", status: "cancelled"});
        expect((updates[6] as {name?: string}).name).toBeUndefined();
    });

    it("maps guardian reviews and fuzzy file searches as create-then-patch", async () => {
        const t = await openPrompting();
        const review = {threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 0, reviewId: "rv1", targetItemId: null, review: {status: "inProgress" as const, riskLevel: null, userAuthorization: null, rationale: null}, action: {type: "command" as const, source: "shell" as const, command: "rm -rf build", cwd: CWD}};
        t.codex.emit({method: "item/autoApprovalReview/started", params: review});
        t.codex.emit({method: "item/autoApprovalReview/completed", params: {...review, completedAtMs: 1, decisionSource: "agent", review: {...review.review, status: "denied", rationale: "destructive"}}});
        t.codex.emit({method: "fuzzyFileSearch/sessionUpdated", params: {sessionId: "fz1", query: "cfg", files: [{root: CWD, path: "src/config.ts", match_type: "file", file_name: "config.ts", score: 1, indices: null}]}});
        t.codex.emit({method: "fuzzyFileSearch/sessionUpdated", params: {sessionId: "fz1", query: "config", files: []}});
        t.codex.emit({method: "fuzzyFileSearch/sessionCompleted", params: {sessionId: "fz1"}});
        await t.settle();
        const updates = t.client.updatesOf("tool_call_update");
        expect(updates[0]).toMatchObject({toolCallId: "guardian-review:rv1", name: "guardian_review", kind: "think", status: "in_progress"});
        expect((updates[0]?.content?.[0] as {content: {text: string}}).content.text).toContain("shell rm -rf build");
        expect(updates[1]).toMatchObject({toolCallId: "guardian-review:rv1", status: "failed"});
        expect((updates[1] as {name?: string}).name).toBeUndefined();
        expect((updates[1]?.content?.[0] as {content: {text: string}}).content.text).toContain("Rationale: destructive");
        expect(updates[2]).toMatchObject({toolCallId: "fuzzy-file-search:fz1", name: "fuzzy_file_search", kind: "search", title: "Search for 'cfg'", locations: [{path: `${CWD}/src/config.ts`}]});
        expect((updates[3] as {name?: string}).name).toBeUndefined();
        expect(updates[3]).toMatchObject({title: "Search for 'config'"});
        expect(updates[4]).toMatchObject({toolCallId: "fuzzy-file-search:fz1", status: "completed"});
    });

    it("echoes terminal stdin, patches file changes, and streams raw reasoning text", async () => {
        const t = await openPrompting();
        itemStarted(t.codex, {type: "commandExecution", id: "c9", pluginId: null, scriptPath: null, command: "python", cwd: CWD, processId: "p1", source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null});
        t.codex.emit({method: "item/commandExecution/terminalInteraction", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "c9", processId: "p1", stdin: "print(1)"}});
        t.codex.emit({method: "item/fileChange/patchUpdated", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "f9", changes: [{path: `${CWD}/x.txt`, kind: {type: "add"}, diff: "x\n"}]}});
        t.codex.emit({method: "item/reasoning/textDelta", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: "r9", delta: "raw", contentIndex: 0}});
        await t.settle();
        expect(t.client.updatesOf("terminal_output_chunk")[0]).toMatchObject({terminalId: "c9", data: Buffer.from("\nprint(1)\n").toString("base64")});
        expect(t.client.updatesOf("tool_call_update").at(-1)).toMatchObject({toolCallId: "f9", title: "Edit x.txt", locations: [{path: `${CWD}/x.txt`}]});
        expect(t.client.updatesOf("agent_thought_chunk")[0]).toMatchObject({messageId: "r9", content: {text: "raw"}});
    });

    it("turns config warnings, deprecation notices, retries, and review exits into frames", async () => {
        const t = await openPrompting();
        t.codex.emit({method: "configWarning", params: {summary: "bad key", details: "line 3"}});
        t.codex.emit({method: "deprecationNotice", params: {summary: "old flag", details: null}});
        t.codex.emit({method: "error", params: {threadId: THREAD_ID, turnId: TURN_ID, willRetry: true, error: {message: "reconnecting", codexErrorInfo: null, additionalDetails: null, misalignment: null}}});
        itemCompleted(t.codex, {type: "exitedReviewMode", id: "rv", review: "Looks fine."});
        itemCompleted(t.codex, {type: "enteredReviewMode", id: "rv0", review: "x"});
        await t.settle();
        const chunks = t.client.updatesOf("agent_message_chunk");
        expect((chunks[0]?.content as {text: string}).text).toBe("bad key\n\nline 3\n\n");
        expect((chunks[1]?.content as {text: string}).text).toBe("old flag\n\n");
        expect(t.client.updatesOf("session_info_update")[0]).toMatchObject({_meta: {codex: {retry: {message: "reconnecting", turnId: TURN_ID}}}});
        expect(chunks[2]).toMatchObject({messageId: "rv", content: {text: "Looks fine."}});
        expect(chunks).toHaveLength(3);
    });

    it("reports a non-retry error even when Codex then completes the turn", async () => {
        const t = await openPrompting();
        t.codex.emit({method: "error", params: {threadId: THREAD_ID, turnId: TURN_ID, willRetry: false, error: {message: "stream broke", codexErrorInfo: "other", additionalDetails: "details", misalignment: null}}});
        t.codex.emit({method: "turn/completed", params: {threadId: THREAD_ID, turn: {id: TURN_ID, items: [], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null}}});
        await t.settle();
        expect(t.client.updatesOf("agent_message_chunk").at(-1)?.content).toEqual({type: "text", text: "stream broke\n\ndetails"});
        expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({state: "idle", stopReason: "_error"});
    });
});
