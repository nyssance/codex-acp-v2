import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import path from "node:path";
import type {
    FuzzyFileSearchSessionCompletedNotification,
    FuzzyFileSearchSessionUpdatedNotification,
} from "../app-server";
import type {JsonValue} from "../app-server/serde_json/JsonValue";
import type {
    CollabAgentToolCallStatus,
    CommandAction,
    CommandExecutionStatus,
    DynamicToolCallStatus,
    GuardianApprovalReview,
    GuardianApprovalReviewAction,
    GuardianApprovalReviewStatus,
    ItemGuardianApprovalReviewCompletedNotification,
    ItemGuardianApprovalReviewStartedNotification,
    McpToolCallError,
    McpToolCallResult,
    McpToolCallStatus,
    PatchApplyStatus,
    ThreadItem,
} from "../app-server/v2";
import {changePaths, diffContent} from "./diff";
import {usesTerminal} from "./terminal";
import {stripShellPrefix} from "../util/shell";

type Item<T extends ThreadItem["type"]> = ThreadItem & {type: T};
type CodexStatus = CommandExecutionStatus | PatchApplyStatus | McpToolCallStatus | DynamicToolCallStatus | CollabAgentToolCallStatus;

/** A `tool_call_update` frame; the first frame for an id carries `name`, later frames patch. */
export type ToolCallFrame = acp.ToolCallUpdate & {sessionUpdate: "tool_call_update"};

/** Stable tool names, so clients can group and style Codex actions consistently. */
export const ToolName = {
    Shell: "shell",
    ReadFile: "read_file",
    ListFiles: "list_files",
    Search: "search",
    ApplyPatch: "apply_patch",
    Mcp: "mcp",
    DynamicTool: "dynamic_tool",
    WebSearch: "web_search",
    ViewImage: "view_image",
    ImageGeneration: "image_generation",
    SubAgent: "subagent",
    Collab: "collab",
    FuzzySearch: "fuzzy_file_search",
    GuardianReview: "guardian_review",
    McpStartup: "mcp_startup",
    PlanReview: "plan_review",
} as const;

export function toAcpStatus(status: CodexStatus): acp.ToolCallStatus {
    switch (status) {
        case "inProgress":
            return "in_progress";
        case "completed":
            return "completed";
        case "failed":
        case "declined":
            return "failed";
        case "interrupted":
            return "cancelled";
    }
}

export function toolCallCancelled(toolCallId: string): ToolCallFrame {
    return frame({toolCallId, status: "cancelled"});
}

function frame(fields: acp.ToolCallUpdate): ToolCallFrame {
    return {sessionUpdate: "tool_call_update", ...fields};
}

function textContent(text: string): acp.ToolCallContent {
    return {type: "content", content: {type: "text", text}};
}

// ---- file changes -----------------------------------------------------------

export function fileChangeStarted(item: Item<"fileChange">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        name: ToolName.ApplyPatch,
        title: fileChangeTitle(item),
        kind: "edit",
        status: toAcpStatus(item.status),
        content: item.changes.map(diffContent),
        locations: changePaths(item.changes).map(p => ({path: p})),
    });
}

export function fileChangePatched(item: Item<"fileChange">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        title: fileChangeTitle(item),
        content: item.changes.map(diffContent),
        locations: changePaths(item.changes).map(p => ({path: p})),
    });
}

export function fileChangeCompleted(item: Item<"fileChange">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        status: toAcpStatus(item.status),
        content: item.changes.map(diffContent),
    });
}

function fileChangeTitle(item: Item<"fileChange">): string {
    const paths = changePaths(item.changes);
    if (paths.length === 1) return `Edit ${path.basename(paths[0]!)}`;
    return `Edit ${paths.length} files`;
}

// ---- commands ----------------------------------------------------------------

export function commandStarted(item: Item<"commandExecution">): ToolCallFrame {
    const action = item.commandActions.length === 1 ? item.commandActions[0] : undefined;
    const status = toAcpStatus(item.status);
    if (action) {
        switch (action.type) {
            case "read":
                return frame({
                    toolCallId: item.id,
                    name: ToolName.ReadFile,
                    title: `Read ${action.path}`,
                    kind: "read",
                    status,
                    locations: [{path: action.path}],
                    rawInput: {command: item.command, cwd: item.cwd, path: action.path},
                });
            case "search":
                return frame({
                    toolCallId: item.id,
                    name: ToolName.Search,
                    title: searchTitle(action.query, action.path),
                    kind: "search",
                    status,
                    ...(action.path ? {locations: [{path: action.path}]} : {}),
                    rawInput: {command: item.command, cwd: item.cwd, query: action.query, path: action.path},
                });
            case "listFiles":
                return frame({
                    toolCallId: item.id,
                    name: ToolName.ListFiles,
                    title: action.path ? `List files in ${action.path}` : "List files",
                    kind: "read",
                    status,
                    ...(action.path ? {locations: [{path: action.path}]} : {}),
                    rawInput: {command: item.command, cwd: item.cwd, path: action.path},
                });
            case "unknown":
                break;
        }
    }
    return frame({
        toolCallId: item.id,
        name: ToolName.Shell,
        title: stripShellPrefix(item.command),
        kind: "execute",
        status,
        content: [{type: "terminal", terminalId: item.id}],
        rawInput: {command: item.command, cwd: item.cwd},
    });
}

export function commandCompleted(item: Item<"commandExecution">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        status: item.status === "completed" ? "completed" : "failed",
        rawOutput: {
            output: item.aggregatedOutput ?? "",
            exitCode: item.exitCode,
            durationMs: item.durationMs,
        },
        ...(usesTerminal(item) || !item.aggregatedOutput ? {} : {content: [textContent(item.aggregatedOutput)]}),
    });
}

export function commandActionPaths(actions: readonly CommandAction[] | null | undefined): string[] {
    const paths: string[] = [];
    for (const action of actions ?? []) {
        if (action.type === "read") paths.push(action.path);
        else if ((action.type === "search" || action.type === "listFiles") && action.path) paths.push(action.path);
    }
    return [...new Set(paths)];
}

export function searchTitle(query: string | null, searchPath: string | null): string {
    if (query && searchPath) return `Search for '${query}' in ${searchPath}`;
    if (query) return `Search for '${query}'`;
    if (searchPath) return `Search in ${searchPath}`;
    return "Search";
}

// ---- MCP and dynamic tools ---------------------------------------------------

export function mcpToolCallStarted(item: Item<"mcpToolCall">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        name: ToolName.Mcp,
        title: `${item.server}.${item.tool}`,
        kind: "execute",
        status: toAcpStatus(item.status),
        rawInput: mcpRawInput(item),
        ...(item.result === null && item.error === null ? {} : {rawOutput: mcpRawOutput(item)}),
        _meta: {codex: {mcp: {server: item.server, tool: item.tool}}},
    });
}

export function mcpToolCallCompleted(item: Item<"mcpToolCall">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        status: toAcpStatus(item.status),
        rawOutput: mcpRawOutput(item),
        ...(item.error ? {content: [textContent(item.error.message)]} : {}),
    });
}

export function mcpToolCallProgress(itemId: string, message: string): ToolCallFrame {
    return frame({toolCallId: itemId, content: [textContent(message.trim())]});
}

function mcpRawInput(item: Item<"mcpToolCall">): Record<string, JsonValue> {
    return {server: item.server, tool: item.tool, arguments: item.arguments};
}

function mcpRawOutput(item: Item<"mcpToolCall">): {result: McpToolCallResult | null; error: McpToolCallError | null} {
    return {result: item.result, error: item.error};
}

export function dynamicToolCallStarted(item: Item<"dynamicToolCall">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        name: ToolName.DynamicTool,
        title: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        kind: "execute",
        status: toAcpStatus(item.status),
        rawInput: {tool: item.tool, namespace: item.namespace, arguments: item.arguments},
    });
}

export function dynamicToolCallCompleted(item: Item<"dynamicToolCall">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        status: toAcpStatus(item.status),
        rawOutput: {success: item.success, contentItems: item.contentItems, durationMs: item.durationMs},
    });
}

// ---- web search, images, compaction ------------------------------------------

export function webSearchStarted(item: Item<"webSearch">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        name: ToolName.WebSearch,
        title: webSearchTitle(item),
        kind: "fetch",
        status: "in_progress",
        rawInput: {query: item.query, action: item.action},
    });
}

export function webSearchCompleted(item: Item<"webSearch">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        title: webSearchTitle(item),
        status: "completed",
        rawInput: {query: item.query, action: item.action},
        ...(item.results === null ? {} : {rawOutput: {results: item.results}}),
    });
}

export function webSearchSnapshot(item: Item<"webSearch">): ToolCallFrame {
    return {...webSearchStarted(item), status: "completed", ...(item.results === null ? {} : {rawOutput: {results: item.results}})};
}

export function webSearchTitle(item: Item<"webSearch">): string {
    const action = item.action;
    if (!action) return item.query ? `Web search: ${item.query}` : "Web search";
    switch (action.type) {
        case "search": {
            const queries = (action.queries ?? []).filter(query => query.length > 0);
            const query = action.query ?? (queries.length > 0 ? queries.join(", ") : item.query);
            return query ? `Web search: ${query}` : "Web search";
        }
        case "openPage":
            return action.url ? `Open page: ${action.url}` : "Open page";
        case "findInPage": {
            const pattern = action.pattern ? ` for '${action.pattern}'` : "";
            const url = action.url ? ` in ${action.url}` : "";
            return `Find in page${pattern}${url}`;
        }
        case "other":
            return "Web search";
    }
}

export function imageViewed(item: Item<"imageView">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        name: ToolName.ViewImage,
        title: `View image ${path.basename(item.path)}`,
        kind: "read",
        status: "completed",
        content: [{type: "content", content: {type: "resource_link", name: path.basename(item.path), uri: item.path}}],
        locations: [{path: item.path}],
        rawInput: {path: item.path},
    });
}

export function imageGenerationStarted(item: Item<"imageGeneration">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        name: ToolName.ImageGeneration,
        title: "Generate image",
        kind: "other",
        status: "in_progress",
        rawInput: {id: item.id},
    });
}

export function imageGenerationCompleted(item: Item<"imageGeneration">): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        status: item.status === "failed" || item.failure !== null ? "failed" : "completed",
        content: imageGenerationContent(item),
        rawOutput: {
            status: item.status,
            revisedPrompt: item.revisedPrompt,
            savedPath: item.savedPath ?? null,
            failure: item.failure,
        },
    });
}

export function imageGenerationSnapshot(item: Item<"imageGeneration">): ToolCallFrame {
    return {...imageGenerationStarted(item), ...imageGenerationCompleted(item)};
}

function imageGenerationContent(item: Item<"imageGeneration">): acp.ToolCallContent[] {
    const content: acp.ToolCallContent[] = [];
    if (item.revisedPrompt?.trim()) content.push(textContent(`Revised prompt: ${item.revisedPrompt}`));
    if (item.result.trim().length > 0) {
        content.push({
            type: "content",
            content: {
                type: "image",
                data: item.result,
                mimeType: "image/png",
                ...(item.savedPath?.trim() ? {uri: item.savedPath} : {}),
            },
        });
    }
    if (item.failure) content.push(textContent(`Image generation failed: ${JSON.stringify(item.failure)}`));
    return content;
}

/**
 * Context compaction is its own ACP v2 update (`compaction_update`, SDK 1.4), not a
 * tool call: Codex's contextCompaction item id is the compactionId. Codex reports no
 * summary text on the item, so no `compaction_summary_chunk` is emitted.
 */
export function compactionUpdate(compactionId: string, status: "in_progress" | "completed"): acp.SessionUpdate {
    return {sessionUpdate: "compaction_update", compactionId, status};
}

// ---- sub-agents ----------------------------------------------------------------

export function subAgentActivity(item: Item<"subAgentActivity">, status: acp.ToolCallStatus, create: boolean): ToolCallFrame {
    const name = item.agentPath.split("/").filter(Boolean).at(-1) ?? "subagent";
    const titles = {
        started: `Start subagent ${name}`,
        interacted: `Interact with subagent ${name}`,
        interrupted: `Interrupt subagent ${name}`,
        completed: `Complete subagent ${name}`,
    } as const;
    return frame({
        toolCallId: item.id,
        ...(create ? {name: ToolName.SubAgent, title: titles[item.kind], kind: "other"} : {}),
        status,
        rawInput: {agentThreadId: item.agentThreadId, agentPath: item.agentPath, activity: item.kind},
        _meta: {codex: {subagent: {threadId: item.agentThreadId, path: item.agentPath, activity: item.kind}}},
    });
}

export function collabToolCall(item: Item<"collabAgentToolCall">, create: boolean): ToolCallFrame {
    return frame({
        toolCallId: item.id,
        ...(create ? {name: ToolName.Collab, title: item.tool, kind: "other"} : {}),
        status: toAcpStatus(item.status),
        rawInput: {
            prompt: item.prompt,
            senderThreadId: item.senderThreadId,
            receiverThreadIds: item.receiverThreadIds,
            agentsStates: item.agentsStates,
            model: item.model,
            reasoningEffort: item.reasoningEffort,
        },
        _meta: {codex: {collaboration: {tool: item.tool, senderThreadId: item.senderThreadId, receiverThreadIds: item.receiverThreadIds}}},
    });
}

// ---- fuzzy file search ---------------------------------------------------------

export function fuzzySearchToolCallId(searchSessionId: string): string {
    return `fuzzy-file-search:${searchSessionId}`;
}

export function fuzzySearchUpdated(event: FuzzyFileSearchSessionUpdatedNotification, create: boolean): ToolCallFrame {
    return frame({
        toolCallId: fuzzySearchToolCallId(event.sessionId),
        ...(create ? {name: ToolName.FuzzySearch, kind: "search"} : {}),
        title: searchTitle(event.query, null),
        status: "in_progress",
        locations: event.files.map(file => ({path: path.isAbsolute(file.path) ? file.path : path.join(file.root, file.path)})),
        rawInput: {query: event.query},
    });
}

export function fuzzySearchCompleted(event: FuzzyFileSearchSessionCompletedNotification): ToolCallFrame {
    return frame({toolCallId: fuzzySearchToolCallId(event.sessionId), status: "completed"});
}

// ---- guardian review -----------------------------------------------------------

type GuardianReviewEvent = ItemGuardianApprovalReviewStartedNotification | ItemGuardianApprovalReviewCompletedNotification;

export function guardianReviewToolCallId(reviewId: string): string {
    return `guardian-review:${reviewId}`;
}

export function guardianReview(event: GuardianReviewEvent, create: boolean): ToolCallFrame {
    return frame({
        toolCallId: guardianReviewToolCallId(event.reviewId),
        ...(create ? {name: ToolName.GuardianReview, title: "Guardian review", kind: "think"} : {}),
        status: guardianStatus(event.review.status),
        content: [textContent(guardianReviewText(event.review, event.action))],
        rawOutput: event as unknown as Record<string, JsonValue>,
    });
}

function guardianStatus(status: GuardianApprovalReviewStatus): acp.ToolCallStatus {
    switch (status) {
        case "inProgress":
            return "in_progress";
        case "approved":
            return "completed";
        case "denied":
        case "aborted":
        case "timedOut":
            return "failed";
    }
}

function guardianReviewText(review: GuardianApprovalReview, action: GuardianApprovalReviewAction): string {
    const lines = [`Status: ${review.status}`];
    const summary = guardianActionSummary(action);
    if (summary) lines.push(`Action: ${summary}`);
    if (review.riskLevel) lines.push(`Risk: ${review.riskLevel}`);
    if (review.userAuthorization) lines.push(`Authorization: ${review.userAuthorization}`);
    if (review.rationale?.trim()) lines.push(`Rationale: ${review.rationale}`);
    return lines.join("\n");
}

function guardianActionSummary(action: GuardianApprovalReviewAction): string | null {
    switch (action.type) {
        case "command":
            return `${action.source} ${action.command}`;
        case "execve":
            return `${action.source} ${(action.argv.length > 0 ? action.argv : [action.program]).join(" ")}`;
        case "applyPatch":
            return action.files.length === 1 ? `apply_patch touching ${action.files[0]}` : `apply_patch touching ${action.files.length} files`;
        case "networkAccess":
            return `network access to ${action.target.length > 0 ? action.target : action.host}`;
        case "writeStdin":
            return `write stdin to process ${action.processId}`;
        case "mcpToolCall":
            return `MCP ${action.toolName} on ${action.connectorName ?? action.server}`;
        case "requestPermissions":
            return action.reason ?? "request additional permissions";
    }
}

// ---- MCP startup ------------------------------------------------------------------

export function mcpStartupFailed(serverName: string, message: string): ToolCallFrame {
    return frame({
        toolCallId: `mcp-startup:${encodeURIComponent(serverName)}`,
        name: ToolName.McpStartup,
        title: `Start MCP server ${serverName}`,
        kind: "other",
        status: "failed",
        content: [textContent(message)],
        rawInput: {server: serverName},
    });
}
