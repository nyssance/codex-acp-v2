import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {describe, expect, it} from "vitest";
import type {
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalResponse,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    PermissionsRequestApprovalResponse,
    ToolRequestUserInputResponse,
} from "../app-server/v2";
import {createTestAgent, CWD, itemStarted, THREAD_ID, TURN_ID, turnCompleted} from "./harness";

async function openPrompting(capabilities?: acp.ClientCapabilities) {
    const t = createTestAgent();
    await t.initialize(capabilities);
    await t.openSession();
    await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "go"}]});
    await t.settle();
    t.client.clear();
    return t;
}

function commandParams(overrides: Partial<CommandExecutionRequestApprovalParams> = {}): CommandExecutionRequestApprovalParams {
    return {
        kind: "command",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "cmd-1",
        startedAtMs: 0,
        environmentId: null,
        command: "/bin/zsh -lc 'rm -rf build'",
        cwd: CWD,
        commandActions: [{type: "unknown", command: "rm -rf build"}],
        reason: "Cleans the build directory",
        ...overrides,
    };
}

describe("command approvals", () => {
    it("presents the command as a v2 permission request and returns the selected decision", async () => {
        const t = await openPrompting();
        t.client.permissionResponder = () => ({outcome: {outcome: "selected", optionId: "allow_for_session"}});
        const response = await t.codex.serverRequest<CommandExecutionRequestApprovalResponse>("item/commandExecution/requestApproval", commandParams({proposedExecpolicyAmendment: ["rm", "-rf"]}));
        expect(response).toEqual({decision: "acceptForSession"});
        const request = t.client.permissionRequests()[0]!;
        expect(request).toMatchObject({
            sessionId: THREAD_ID,
            title: "Run command?",
            description: "Cleans the build directory",
            subject: {type: "tool_call", toolCall: {toolCallId: "cmd-1", name: "shell", kind: "execute", status: "pending", title: "rm -rf build", rawInput: {command: "rm -rf build", cwd: CWD}}},
        });
        expect(request.options.map(option => [option.optionId, option.kind])).toEqual([
            ["allow_once", "allow_once"],
            ["allow_for_session", "allow_always"],
            ["accept_execpolicy_amendment", "allow_always"],
            ["decline", "reject_once"],
            ["cancel", "reject_once"],
        ]);
        expect(request.options[2]?.name).toContain("rm -rf");
    });

    it("reports requires_action while the prompt is open and running afterwards", async () => {
        const t = await openPrompting();
        let release: () => void = () => {};
        t.client.permissionResponder = () => new Promise(resolve => {
            release = () => resolve({outcome: {outcome: "selected", optionId: "allow_once"}});
        });
        const pending = t.codex.serverRequest<CommandExecutionRequestApprovalResponse>("item/commandExecution/requestApproval", commandParams());
        await t.settle();
        expect(t.client.states()).toEqual(["requires_action"]);
        release();
        expect(await pending).toEqual({decision: "accept"});
        await t.settle();
        expect(t.client.states()).toEqual(["requires_action", "running"]);
    });

    it("fails closed on cancel, unknown options, and client errors", async () => {
        const t = await openPrompting();
        t.client.permissionResponder = () => ({outcome: {outcome: "cancelled"}});
        expect(await t.codex.serverRequest("item/commandExecution/requestApproval", commandParams())).toEqual({decision: "cancel"});
        t.client.permissionResponder = () => ({outcome: {outcome: "selected", optionId: "made-up"}});
        expect(await t.codex.serverRequest("item/commandExecution/requestApproval", commandParams())).toEqual({decision: "cancel"});
        t.client.permissionResponder = () => {
            throw new Error("client gone");
        };
        expect(await t.codex.serverRequest("item/commandExecution/requestApproval", commandParams())).toEqual({decision: "cancel"});
    });

    it("honours an authoritative availableDecisions list and rejects malformed ones", async () => {
        const t = await openPrompting();
        t.client.permissionResponder = () => ({outcome: {outcome: "selected", optionId: "allow_once"}});
        const params = {...commandParams(), availableDecisions: ["accept", "cancel"]};
        expect(await t.codex.serverRequest("item/commandExecution/requestApproval", params)).toEqual({decision: "accept"});
        expect(t.client.permissionRequests()[0]?.options.map(option => option.optionId)).toEqual(["allow_once", "cancel"]);
        const malformed = {...commandParams(), availableDecisions: [{acceptWithExecpolicyAmendment: {execpolicy_amendment: ["ls"]}}]};
        expect(await t.codex.serverRequest("item/commandExecution/requestApproval", malformed)).toEqual({decision: "cancel"});
        expect(t.client.permissionRequests()).toHaveLength(1);
    });

    it("maps network approvals with policy amendments", async () => {
        const t = await openPrompting();
        t.client.permissionResponder = () => ({outcome: {outcome: "selected", optionId: "apply_network_policy_amendment:0"}});
        const response = await t.codex.serverRequest("item/commandExecution/requestApproval", commandParams({
            networkApprovalContext: {host: "api.example.com", protocol: "https"},
            proposedNetworkPolicyAmendments: [{host: "api.example.com", action: "allow"}],
        }));
        expect(response).toEqual({decision: {applyNetworkPolicyAmendment: {network_policy_amendment: {host: "api.example.com", action: "allow"}}}});
        const request = t.client.permissionRequests()[0]!;
        expect(request.title).toBe("Allow network access?");
        expect(request.subject).toMatchObject({toolCall: {title: "https network access to api.example.com", rawInput: {url: "https://api.example.com"}}});
    });

    it("fails closed when Codex asks before any session exists", async () => {
        const t = createTestAgent();
        await t.initialize();
        expect(await t.codex.serverRequest("item/commandExecution/requestApproval", commandParams())).toEqual({decision: "cancel"});
    });
});

describe("file change approvals", () => {
    it("attaches the pending file change diff to the permission subject", async () => {
        const t = await openPrompting();
        itemStarted(t.codex, {type: "fileChange", id: "fc-1", status: "inProgress", changes: [{path: `${CWD}/a.txt`, kind: {type: "add"}, diff: "x\n"}]});
        await t.settle();
        t.client.permissionResponder = () => ({outcome: {outcome: "selected", optionId: "allow_once"}});
        const response = await t.codex.serverRequest<FileChangeRequestApprovalResponse>("item/fileChange/requestApproval", {threadId: THREAD_ID, turnId: TURN_ID, itemId: "fc-1", startedAtMs: 0, reason: null});
        expect(response).toEqual({decision: "accept"});
        const request = t.client.permissionRequests()[0]!;
        expect(request).toMatchObject({title: "Make edits?", subject: {toolCall: {toolCallId: "fc-1", kind: "edit", title: `Edit ${CWD}/a.txt`, locations: [{path: `${CWD}/a.txt`}]}}});
        expect(request.description).toBeNull();
        expect(request.options.map(option => option.optionId)).toEqual(["allow_once", "allow_for_session", "cancel"]);
    });
});

describe("permission profile approvals", () => {
    it("grants exactly the requested permissions with the chosen scope", async () => {
        const t = await openPrompting();
        const permissions = {network: {enabled: true}, fileSystem: {read: ["/etc"], write: null}};
        t.client.permissionResponder = () => ({outcome: {outcome: "selected", optionId: "allow_permissions_turn_strict_auto_review"}});
        const response = await t.codex.serverRequest<PermissionsRequestApprovalResponse>("item/permissions/requestApproval", {threadId: THREAD_ID, turnId: TURN_ID, itemId: "p-1", environmentId: null, startedAtMs: 0, cwd: CWD, reason: "needs /etc", permissions});
        expect(response).toEqual({permissions, scope: "turn", strictAutoReview: true});
        expect(t.client.permissionRequests()[0]).toMatchObject({title: "Grant permissions?", description: "needs /etc", subject: {toolCall: {locations: [{path: "/etc"}]}}});
        t.client.permissionResponder = () => ({outcome: {outcome: "cancelled"}});
        expect(await t.codex.serverRequest("item/permissions/requestApproval", {threadId: THREAD_ID, turnId: TURN_ID, itemId: "p-2", environmentId: null, startedAtMs: 0, cwd: CWD, reason: null, permissions}))
            .toEqual({permissions: {}, scope: "turn", strictAutoReview: false});
    });
});

describe("MCP elicitations", () => {
    const formParams: McpServerElicitationRequestParams = {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        serverName: "srv",
        mode: "form",
        _meta: null,
        message: "Pick one",
        requestedSchema: {type: "object", properties: {choice: {type: "string", enum: ["a", "b"], enumNames: ["A", "B"]}}, required: ["choice"]},
    };

    it("uses elicitation/create for forms when the client supports it", async () => {
        const t = await openPrompting({elicitation: {form: {}}});
        t.client.elicitationResponder = () => ({action: "accept", content: {choice: "a"}});
        const response = await t.codex.serverRequest<McpServerElicitationRequestResponse>("mcpServer/elicitation/request", formParams);
        expect(response).toEqual({action: "accept", content: {choice: "a"}, _meta: null});
        const request = t.client.requests[0]?.params as acp.CreateElicitationRequest & {requestedSchema: {properties: Record<string, unknown>}};
        expect(request.mode).toBe("form");
        expect(request.requestedSchema.properties["choice"]).toEqual({type: "string", oneOf: [{const: "a", title: "A"}, {const: "b", title: "B"}]});
        expect(t.client.states()).toEqual(["requires_action", "running"]);
    });

    it("cancels structured forms the client cannot render instead of guessing", async () => {
        const t = await openPrompting();
        expect(await t.codex.serverRequest("mcpServer/elicitation/request", formParams)).toEqual({action: "cancel", content: null, _meta: null});
        expect(t.client.requests).toHaveLength(0);
    });

    it("routes message-only tool approvals through permissions and correlates the tool call", async () => {
        const t = await openPrompting();
        itemStarted(t.codex, {type: "mcpToolCall", id: "m-1", server: "srv", tool: "run", status: "inProgress", arguments: {}, appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null});
        await t.settle();
        t.client.clear();
        t.client.permissionResponder = () => ({outcome: {outcome: "selected", optionId: "allow_session"}});
        const response = await t.codex.serverRequest("mcpServer/elicitation/request", {
            ...formParams,
            _meta: {codex_approval_kind: "mcp_tool_call", persist: ["session"]},
            requestedSchema: {type: "object", properties: {}},
        });
        expect(response).toEqual({action: "accept", content: null, _meta: {persist: "session"}});
        const request = t.client.permissionRequests()[0]!;
        expect(request.subject).toMatchObject({toolCall: {toolCallId: "m-1", status: "pending"}});
        expect(request.options.map(option => option.optionId)).toEqual(["allow_once", "allow_session", "cancel"]);
        expect(t.client.updatesOf("tool_call_update").at(-1)).toMatchObject({toolCallId: "m-1", status: "in_progress"});
    });

    it("completes URL elicitations once Codex resolves the request", async () => {
        const t = await openPrompting({elicitation: {url: {}}});
        t.client.elicitationResponder = () => ({action: "accept"});
        const response = await t.codex.serverRequest("mcpServer/elicitation/request", {threadId: THREAD_ID, turnId: TURN_ID, serverName: "srv", mode: "url", _meta: null, message: "Sign in", url: "https://login", elicitationId: "e-1"});
        expect(response).toEqual({action: "accept", content: null, _meta: null});
        t.codex.emit({method: "serverRequest/resolved", params: {threadId: THREAD_ID, requestId: 1}});
        await t.settle();
        expect(t.client.notifications.find(entry => entry.method === acp.methods.client.elicitation.complete)?.params).toEqual({elicitationId: "e-1"});
    });
});

describe("tool user input", () => {
    it("builds a form from Codex questions and maps answers back, including 'other'", async () => {
        const t = await openPrompting({elicitation: {form: {}}});
        t.client.elicitationResponder = () => ({action: "accept", content: {color: "", color__other: "teal", size: "large"}});
        const response = await t.codex.serverRequest<ToolRequestUserInputResponse>("item/tool/requestUserInput", {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            itemId: "q-1",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
                {id: "color", header: "Color", question: "Which color?", isOther: true, isSecret: false, options: [{label: "red", description: "Red"}]},
                {id: "size", header: "Size", question: "Which size?", isOther: false, isSecret: false, options: null},
            ],
        });
        expect(response).toEqual({answers: {color: {answers: ["teal"]}, size: {answers: ["large"]}}});
        const request = t.client.requests[0]?.params as {toolCallId?: string; requestedSchema: {required: string[]; properties: Record<string, unknown>}};
        expect(request.toolCallId).toBe("q-1");
        expect(request.requestedSchema.required).toEqual(["size"]);
        expect(Object.keys(request.requestedSchema.properties)).toEqual(["color", "color__other", "size"]);
    });

    it("returns no answers when the client cannot render forms", async () => {
        const t = await openPrompting();
        const response = await t.codex.serverRequest("item/tool/requestUserInput", {threadId: THREAD_ID, turnId: TURN_ID, itemId: "q-2", isBlocking: true, autoResolutionMs: null, questions: []});
        expect(response).toEqual({answers: {}});
    });
});

describe("approval ordering", () => {
    it("delivers queued tool call frames before the permission request", async () => {
        const t = await openPrompting();
        const order: string[] = [];
        t.client.notify = (async (method: string, params: unknown) => {
            t.client.notifications.push({method, params});
            order.push(`notify:${(params as acp.UpdateSessionNotification).update.sessionUpdate}`);
        }) as typeof t.client.notify;
        t.client.permissionResponder = () => {
            order.push("permission");
            return {outcome: {outcome: "selected", optionId: "allow_once"}};
        };
        itemStarted(t.codex, {type: "commandExecution", id: "cmd-1", pluginId: null, scriptPath: null, command: "ls", cwd: CWD, processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null});
        await t.codex.serverRequest("item/commandExecution/requestApproval", commandParams());
        expect(order.slice(0, 3)).toEqual(["notify:tool_call_update", "notify:terminal_update", "notify:state_update"]);
        expect(order).toContain("permission");
        turnCompleted(t.codex);
    });
});
