import {describe, expect, it} from "vitest";
import {diffContent, gitPatch} from "../bridge/diff";
import {parseCommand, resolveCommand} from "../agent/commands";
import {ClientSession} from "../agent/clientSession";
import {buildThreadConfig, fromUserInput, promptTitle, readAdditionalDirectories, toUserInput} from "../codex/sessionConfig";
import {coerceEffort, modelSupportsFast, resolveModelSelection} from "../codex/models";
import {renderExecPolicyPrefix} from "../permissions/commandDecisions";
import {stripShellPrefix} from "../util/shell";
import {FakeClient, model, CWD} from "./harness";

describe("gitPatch", () => {
    it("formats additions, deletions, and modifications as git patches", () => {
        expect(gitPatch(null, "/p/a.txt", "", "hi\n")).toBe("--- /dev/null\n+++ /p/a.txt\n@@ -1,0 +1,1 @@\n+hi\n");
        expect(gitPatch("/p/a.txt", null, "hi\n", "")).toBe("--- /p/a.txt\n+++ /dev/null\n@@ -1,1 +1,0 @@\n-hi\n");
        expect(gitPatch("/p/a.txt", "/p/a.txt", "a\nb\nc\n", "a\nB\nc\n")).toBe("--- /p/a.txt\n+++ /p/a.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
    });

    it("passes through Codex unified diffs and adds headers when missing", () => {
        const content = diffContent({path: "/p/x.ts", kind: {type: "update", move_path: null}, diff: "@@ -1,2 +1,2 @@\n a\n-b\n+c\n"}) as {patch: {text: string}};
        expect(content.patch.text).toBe("--- /p/x.ts\n+++ /p/x.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n");
        const withHeaders = diffContent({path: "/p/x.ts", kind: {type: "update", move_path: null}, diff: "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n"}) as {patch: {text: string}};
        expect(withHeaders.patch.text).toBe("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n");
    });
});

describe("prompt conversion", () => {
    it("maps ACP content blocks to Codex user input", () => {
        expect(toUserInput([
            {type: "text", text: "hi"},
            {type: "image", data: "AAA", mimeType: "image/png"},
            {type: "image", data: "", mimeType: "image/png", uri: "https://img/x.png"},
            {type: "resource_link", name: "readme", uri: "file:///p/README.md"},
            {type: "resource", resource: {uri: "file:///p/a.ts", text: "const a = 1;"}},
            {type: "resource", resource: {uri: "file:///p/b.png", blob: "QUJD", mimeType: "image/png"}},
            {type: "audio", data: "x", mimeType: "audio/wav"},
        ])).toEqual([
            {type: "text", text: "hi", text_elements: []},
            {type: "image", url: "data:image/png;base64,AAA"},
            {type: "image", url: "https://img/x.png"},
            {type: "text", text: "[@readme](file:///p/README.md)", text_elements: []},
            {type: "text", text: "[@a.ts](file:///p/a.ts)\n<context ref=\"file:///p/a.ts\">\nconst a = 1;\n</context>", text_elements: []},
            {type: "image", url: "data:image/png;base64,QUJD"},
        ]);
    });

    it("renders Codex input back for history", () => {
        expect(fromUserInput({type: "text", text: "hello", text_elements: []})).toEqual([{type: "text", text: "hello"}]);
        expect(fromUserInput({type: "localImage", path: "/p/i.png"})).toEqual([{type: "text", text: "[@i.png](file:///p/i.png)"}]);
        expect(fromUserInput({type: "mention", name: "doc", path: "/p/doc.md"})).toEqual([{type: "text", text: "[@doc](file:///p/doc.md)"}]);
    });

    it("derives a title from the first non-empty line", () => {
        expect(promptTitle([{type: "text", text: "\n\n  Fix the bug  \nmore"}])).toBe("Fix the bug");
        expect(promptTitle([{type: "image", data: "", mimeType: "image/png"}])).toBeNull();
        expect(promptTitle([{type: "text", text: "x".repeat(200)}])?.length).toBe(120);
    });
});

describe("session config", () => {
    it("validates additional directories", () => {
        expect(readAdditionalDirectories(CWD, [CWD, "/other", "/other"])).toEqual(["/other"]);
        expect(() => readAdditionalDirectories(CWD, ["relative"])).toThrow(/absolute/);
        expect(() => readAdditionalDirectories(CWD, [""])).toThrow(/non-empty/);
    });

    it("rejects unsupported MCP transports", () => {
        expect(() => buildThreadConfig({}, CWD, [], [{type: "acp", name: "x", serverId: "s"}], new Set())).toThrow(/transport "acp"/);
    });

    it("preserves base config and merges writable roots", () => {
        const config = buildThreadConfig({model_provider: "custom", sandbox_workspace_write: {writable_roots: ["/a"], network_access: true}}, CWD, ["/b"], [], new Set());
        expect(config).toMatchObject({model_provider: "custom", sandbox_workspace_write: {writable_roots: ["/a", "/b"], network_access: true}});
    });
});

describe("models", () => {
    it("keeps unknown model ids for custom providers and falls back to the default", () => {
        const catalog = [model({id: "gpt-5", isDefault: true})];
        expect(resolveModelSelection(catalog, "gpt-5", null)).toEqual({model: "gpt-5", effort: "medium"});
        expect(resolveModelSelection(catalog, "my-local-model", "high")).toEqual({model: "my-local-model", effort: "high"});
        expect(resolveModelSelection(catalog, null, null)).toEqual({model: "gpt-5", effort: "medium"});
        expect(() => resolveModelSelection([], null, null)).toThrow(/any models/);
    });

    it("coerces efforts and detects fast tiers", () => {
        const m = model({supportedReasoningEfforts: [{reasoningEffort: "low", description: ""}], defaultReasoningEffort: "low"});
        expect(coerceEffort(m, "high")).toBe("low");
        expect(coerceEffort(undefined, "high")).toBe("high");
        expect(modelSupportsFast(model())).toBe(true);
        expect(modelSupportsFast(model({serviceTiers: [], additionalSpeedTiers: ["fast"]}))).toBe(true);
        expect(modelSupportsFast(model({serviceTiers: []}))).toBe(false);
    });
});

describe("commands", () => {
    it("parses slash commands and leaves skills and plain text alone", () => {
        expect(parseCommand([{type: "text", text: "  /Review-Branch  main  "}])).toEqual({name: "review-branch", rest: "main"});
        expect(parseCommand([{type: "text", text: "/$deploy now"}])).toBeNull();
        expect(parseCommand([{type: "text", text: "hello /status"}])).toBeNull();
        expect(parseCommand([{type: "image", data: "", mimeType: "image/png"}])).toBeNull();
    });

    it("resolves review targets and usage messages", () => {
        const session = {collaborationMode: "default"} as Parameters<typeof resolveCommand>[1];
        expect(resolveCommand({name: "review", rest: ""}, session)).toEqual({kind: "review", target: {type: "uncommittedChanges"}});
        expect(resolveCommand({name: "review", rest: "focus on tests"}, session)).toEqual({kind: "review", target: {type: "custom", instructions: "focus on tests"}});
        expect(resolveCommand({name: "review-commit", rest: ""}, session)).toEqual({kind: "message", text: "Usage: /review-commit <commit sha>"});
        expect(resolveCommand({name: "plan", rest: ""}, session)).toEqual({kind: "config", configId: "collaboration_mode", value: "plan"});
        expect(resolveCommand({name: "unknown", rest: ""}, session)).toEqual({kind: "prompt"});
    });
});

describe("shell helpers", () => {
    it("strips shell wrappers and renders exec-policy prefixes", () => {
        expect(stripShellPrefix("/bin/zsh -lc 'ls -la'")).toBe("ls -la");
        expect(stripShellPrefix("bash -c \"echo hi\"")).toBe("\"echo hi\"");
        expect(stripShellPrefix("ls")).toBe("ls");
        expect(renderExecPolicyPrefix(["bash", "-lc", "npm test"])).toBe("npm test");
        expect(renderExecPolicyPrefix(["git", "commit", "-m", "hello world"])).toBe("git commit -m 'hello world'");
    });
});

describe("ClientSession state reporting", () => {
    it("reports requires_action only while a turn is active", async () => {
        const link = new FakeClient();
        const session = new ClientSession("s", link, {formElicitation: false, urlElicitation: false});
        link.permissionResponder = () => ({outcome: {outcome: "cancelled"}});
        await session.requestPermission({title: "t", options: []});
        expect(link.states()).toEqual([]);
        session.reportRunning();
        await session.requestPermission({title: "t", options: []});
        await session.reportIdle("end_turn");
        expect(link.states()).toEqual(["running", "requires_action", "running", "idle"]);
    });

    it("collapses nested client waits into one requires_action window", async () => {
        const link = new FakeClient();
        const session = new ClientSession("s", link, {formElicitation: true, urlElicitation: false});
        let release: () => void = () => {};
        link.permissionResponder = () => new Promise(resolve => {
            release = () => resolve({outcome: {outcome: "cancelled"}});
        });
        link.elicitationResponder = () => ({action: "cancel"});
        session.reportRunning();
        const first = session.requestPermission({title: "a", options: []});
        await new Promise(resolve => setTimeout(resolve, 0));
        await session.createElicitation({mode: "form", sessionId: "s", message: "m", requestedSchema: {type: "object", properties: {}}});
        release();
        await first;
        expect(link.states()).toEqual(["running", "requires_action", "running"]);
    });
});
