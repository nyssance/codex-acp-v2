import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {JsonValue} from "../app-server/serde_json/JsonValue";
import type {McpServerElicitationRequestParams, McpServerElicitationRequestResponse} from "../app-server/v2";
import {ToolName} from "../bridge/toolCalls";
import {isRecord} from "./json";
import {permissionOption} from "./options";

export type PersistValue = "session" | "always";

export type McpElicitationContext = {
    isToolApproval: boolean;
    persistOptions: Set<PersistValue>;
    correlatedCallId: string | undefined;
};

export const McpOptionId = {
    AllowOnce: "allow_once",
    Accept: "accept",
    AllowSession: "allow_session",
    AllowAlways: "allow_always",
    Decline: "decline",
    Cancel: "cancel",
} as const;

export function parsePersistOptions(meta: unknown): Set<PersistValue> {
    const result = new Set<PersistValue>();
    if (!isRecord(meta)) return result;
    const persist = meta["persist"];
    const values = Array.isArray(persist) ? persist : [persist];
    if (values.includes("session")) result.add("session");
    if (values.includes("always")) result.add("always");
    return result;
}

export function isMcpToolCallApproval(meta: unknown): boolean {
    return isRecord(meta) && meta["codex_approval_kind"] === "mcp_tool_call";
}

export function mcpPermissionOptions(isToolApproval: boolean, persist: ReadonlySet<PersistValue>): acp.PermissionOption[] {
    const options: acp.PermissionOption[] = [permissionOption(
        isToolApproval ? McpOptionId.AllowOnce : McpOptionId.Accept,
        "Allow",
        "allow_once",
        isToolApproval ? "Run the tool and continue." : "Allow this request and continue.",
    )];
    if (persist.has("session")) {
        options.push(permissionOption(McpOptionId.AllowSession, "Allow for this session", "allow_always",
            isToolApproval ? "Run the tool and remember this choice for this session." : "Allow this request and remember this choice for this session."));
    }
    if (persist.has("always")) {
        options.push(permissionOption(McpOptionId.AllowAlways, "Always allow", "allow_always",
            isToolApproval ? "Run the tool and remember this choice for future tool calls." : "Allow this request and remember this choice for future requests."));
    }
    if (!isToolApproval) {
        options.push(permissionOption(McpOptionId.Decline, "Deny", "reject_once", "Decline this request and continue."));
    }
    options.push(permissionOption(McpOptionId.Cancel, "Cancel", "reject_once", isToolApproval ? "Cancel this tool call." : "Cancel this request."));
    return options;
}

/** Builds the permission request used when an MCP elicitation carries no form fields. */
export function mcpPermissionRequest(
    params: McpServerElicitationRequestParams,
    context: McpElicitationContext,
    nextStandaloneToolCallId: () => string,
): Omit<acp.RequestPermissionRequest, "sessionId"> {
    const message: acp.ToolCallContent = {type: "content", content: {type: "text", text: params.message}};
    const options = mcpPermissionOptions(context.isToolApproval, context.persistOptions);
    const title = context.isToolApproval ? `Allow MCP tool call on ${params.serverName}?` : `${params.serverName} requests approval`;
    if (params.mode === "url") {
        return {
            title,
            description: params.message,
            subject: {
                type: "tool_call",
                toolCall: {
                    toolCallId: `elicitation:${params.elicitationId}`,
                    name: ToolName.Mcp,
                    kind: "fetch",
                    status: "pending",
                    title: `Open ${params.url}`,
                    content: [message],
                    rawInput: {serverName: params.serverName, url: params.url},
                },
            },
            options,
        };
    }
    if (context.correlatedCallId !== undefined) {
        return {
            title,
            description: params.message,
            subject: {type: "tool_call", toolCall: {toolCallId: context.correlatedCallId, status: "pending"}},
            options,
        };
    }
    return {
        title,
        description: params.message,
        subject: {
            type: "tool_call",
            toolCall: {
                toolCallId: nextStandaloneToolCallId(),
                name: ToolName.Mcp,
                kind: context.isToolApproval ? "execute" : "other",
                status: "pending",
                title,
                content: [message],
                rawInput: {serverName: params.serverName, schema: params.requestedSchema},
            },
        },
        options,
    };
}

export function mcpPermissionResponse(
    response: acp.RequestPermissionResponse,
    isToolApproval: boolean,
    persist: ReadonlySet<PersistValue>,
): McpServerElicitationRequestResponse {
    if (response.outcome.outcome !== "selected") return cancelled();
    switch ((response.outcome as {optionId?: unknown}).optionId) {
        case McpOptionId.AllowSession:
            return persist.has("session") ? accepted({persist: "session"}) : cancelled();
        case McpOptionId.AllowAlways:
            return persist.has("always") ? accepted({persist: "always"}) : cancelled();
        case McpOptionId.AllowOnce:
            return isToolApproval ? accepted(null) : cancelled();
        case McpOptionId.Accept:
            return isToolApproval ? cancelled() : accepted(null);
        case McpOptionId.Decline:
            return isToolApproval ? cancelled() : {action: "decline", content: null, _meta: null};
        default:
            return cancelled();
    }
}

function accepted(meta: JsonValue | null): McpServerElicitationRequestResponse {
    return {action: "accept", content: null, _meta: meta};
}

export function cancelled(): McpServerElicitationRequestResponse {
    return {action: "cancel", content: null, _meta: null};
}
