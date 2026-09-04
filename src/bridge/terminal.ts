import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {ThreadItem} from "../app-server/v2";

type CommandExecutionItem = ThreadItem & {type: "commandExecution"};

/**
 * Commands that Codex could not classify as a friendly action (read, search,
 * list files) stream through an agent-owned ACP terminal keyed by the item id.
 */
export function usesTerminal(item: CommandExecutionItem): boolean {
    const action = item.commandActions.length === 1 ? item.commandActions[0] : undefined;
    return action === undefined || action.type === "unknown";
}

export function terminalStarted(item: CommandExecutionItem): acp.SessionUpdate {
    return {
        sessionUpdate: "terminal_update",
        terminalId: item.id,
        command: item.command,
        cwd: item.cwd,
    };
}

export function terminalOutputChunk(terminalId: string, data: string): acp.SessionUpdate {
    return {
        sessionUpdate: "terminal_output_chunk",
        terminalId,
        data: encode(data),
    };
}

/** Final state: the aggregated output is an authoritative snapshot, so clients that missed chunks still converge. */
export function terminalExited(item: CommandExecutionItem): acp.SessionUpdate {
    return {
        sessionUpdate: "terminal_update",
        terminalId: item.id,
        ...(item.aggregatedOutput === null ? {} : {output: {data: encode(item.aggregatedOutput)}}),
        exitStatus: {exitCode: item.exitCode, signal: null},
    };
}

/** Whole-terminal snapshot for history replay: command, full output, and exit status in one frame. */
export function terminalSnapshot(item: CommandExecutionItem): acp.SessionUpdate {
    return {
        sessionUpdate: "terminal_update",
        terminalId: item.id,
        command: item.command,
        cwd: item.cwd,
        output: {data: encode(item.aggregatedOutput ?? "")},
        ...(item.status === "inProgress" ? {} : {exitStatus: {exitCode: item.exitCode, signal: null}}),
    };
}

function encode(text: string): string {
    return Buffer.from(text, "utf8").toString("base64");
}
