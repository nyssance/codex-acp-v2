import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {
    AdditionalPermissionProfile,
    CommandAction,
    FileChangeRequestApprovalParams,
    RequestPermissionProfile,
    ThreadItem,
} from "../app-server/v2";
import {commandActionPaths, ToolName} from "../bridge/toolCalls";
import {changePaths, diffContent} from "../bridge/diff";
import {stripShellPrefix} from "../util/shell";
import type {CommandApprovalParams} from "./commandDecisions";

export const COMMAND_TITLE = "Run command?";
export const NETWORK_TITLE = "Allow network access?";
export const FILE_CHANGE_TITLE = "Make edits?";
export const PERMISSIONS_TITLE = "Grant permissions?";

/** The tool call under review. It reuses the Codex item id so clients patch the rendered call. */
export function commandSubject(params: CommandApprovalParams): acp.ToolCallUpdate {
    const network = params.networkApprovalContext;
    const rawInput = {
        ...(params.command ? {command: stripShellPrefix(params.command)} : {}),
        ...(params.cwd ? {cwd: params.cwd} : {}),
        ...(network?.protocol === "http" || network?.protocol === "https" ? {url: `${network.protocol}://${network.host}`} : {}),
        ...(params.additionalPermissions ? {additionalPermissions: params.additionalPermissions} : {}),
    };
    const content: acp.ToolCallContent[] = [];
    if (network) content.push(text(`${network.protocol} access to ${network.host}`));
    if (params.additionalPermissions) content.push(...profileContent(params.additionalPermissions));
    const locations = unique([...commandActionPaths(params.commandActions), ...profilePaths(params.additionalPermissions)]);
    return {
        toolCallId: params.itemId,
        name: ToolName.Shell,
        kind: "execute",
        status: "pending",
        title: network ? `${network.protocol} network access to ${network.host}` : commandTitle(params.command, params.commandActions),
        ...(Object.keys(rawInput).length > 0 ? {rawInput} : {}),
        ...(locations.length > 0 ? {locations: locations.map(path => ({path}))} : {}),
        ...(content.length > 0 ? {content} : {}),
    };
}

export function fileChangeSubject(params: FileChangeRequestApprovalParams, item: (ThreadItem & {type: "fileChange"}) | undefined): acp.ToolCallUpdate {
    const paths = item ? changePaths(item.changes) : [];
    return {
        toolCallId: params.itemId,
        name: ToolName.ApplyPatch,
        kind: "edit",
        status: "pending",
        title: paths.length === 1 ? `Edit ${paths[0]}` : paths.length > 1 ? `Edit ${paths.length} files` : "Edit files",
        ...(paths.length > 0 ? {locations: paths.map(path => ({path}))} : {}),
        ...(item ? {content: item.changes.map(diffContent)} : {}),
        ...(params.grantRoot ? {rawInput: {grantRoot: params.grantRoot}} : {}),
    };
}

export function permissionsSubject(itemId: string, cwd: string, environmentId: string | null, permissions: RequestPermissionProfile): acp.ToolCallUpdate {
    const content = profileContent(permissions);
    const paths = profilePaths(permissions);
    return {
        toolCallId: itemId,
        name: ToolName.Shell,
        kind: "other",
        status: "pending",
        title: "Additional sandbox permissions",
        rawInput: {permissions, cwd, environmentId},
        ...(paths.length > 0 ? {locations: paths.map(path => ({path}))} : {}),
        ...(content.length > 0 ? {content} : {}),
    };
}

function commandTitle(command: string | null | undefined, actions?: CommandAction[] | null): string {
    const first = actions?.[0];
    if (first?.type === "read") return actions?.length === 1 ? `Read ${first.path}` : "Run command with file reads";
    if (first?.type === "listFiles") return "List files";
    if (first?.type === "search") return "Search files";
    return command ? stripShellPrefix(command) : "Run command";
}

function profilePaths(permissions?: RequestPermissionProfile | AdditionalPermissionProfile | null): string[] {
    const fileSystem = permissions?.fileSystem;
    return unique([
        ...(fileSystem?.read ?? []),
        ...(fileSystem?.write ?? []),
        ...(fileSystem?.entries ?? []).flatMap(entry => entry.path.type === "path" ? [entry.path.path] : []),
    ]);
}

function profileContent(permissions: RequestPermissionProfile | AdditionalPermissionProfile): acp.ToolCallContent[] {
    const lines: string[] = [];
    const networkEnabled = permissions.network?.enabled;
    if (networkEnabled !== null && networkEnabled !== undefined) {
        lines.push(networkEnabled ? "Enable network access" : "Disable network access");
    }
    for (const entry of permissions.fileSystem?.entries ?? []) {
        if (entry.path.type === "glob_pattern") lines.push(`${entry.access} filesystem pattern ${entry.path.pattern}`);
        else if (entry.path.type === "special") lines.push(`${entry.access} Codex filesystem scope ${JSON.stringify(entry.path.value)}`);
    }
    return lines.length > 0 ? [text(lines.join("\n"))] : [];
}

function text(value: string): acp.ToolCallContent {
    return {type: "content", content: {type: "text", text: value}};
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}
