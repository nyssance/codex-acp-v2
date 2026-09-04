import type {ServerNotification} from "../app-server";
import type {ThreadItem} from "../app-server/v2";

type FileChangeItem = ThreadItem & {type: "fileChange"};

/**
 * Per-turn correlation state shared by the approval and elicitation handlers:
 * the file-change items awaiting approval and the MCP tool calls whose
 * elicitation-based approval Codex sends without the call id.
 */
export class TurnContext {
    private readonly fileChanges = new Map<string, FileChangeItem>();
    private readonly pendingMcpCalls = new Map<string, string[]>();
    private sequence = 0;

    constructor(private readonly sessionId: string) {}

    observe(notification: ServerNotification): void {
        switch (notification.method) {
            case "item/started":
                this.itemStarted(notification.params.item);
                return;
            case "item/completed":
                this.itemCompleted(notification.params.item);
                return;
            case "turn/completed":
                this.fileChanges.clear();
                this.pendingMcpCalls.clear();
                return;
            case "serverRequest/resolved":
                this.pendingMcpCalls.clear();
                return;
            default:
                return;
        }
    }

    fileChange(itemId: string): FileChangeItem | undefined {
        return this.fileChanges.get(itemId);
    }

    /** Returns the single pending MCP call for the server, when it is unambiguous. */
    popPendingMcpCall(serverName: string): string | undefined {
        const pending = this.pendingMcpCalls.get(serverName);
        if (pending?.length !== 1) return undefined;
        this.pendingMcpCalls.delete(serverName);
        return pending[0];
    }

    nextStandaloneToolCallId(serverName: string): string {
        this.sequence += 1;
        return `elicitation:${this.sessionId}:${serverName}:${this.sequence}`;
    }

    private itemStarted(item: ThreadItem): void {
        if (item.type === "fileChange") {
            this.fileChanges.set(item.id, item);
        } else if (item.type === "mcpToolCall") {
            const pending = this.pendingMcpCalls.get(item.server) ?? [];
            pending.push(item.id);
            this.pendingMcpCalls.set(item.server, pending);
        }
    }

    private itemCompleted(item: ThreadItem): void {
        if (item.type === "fileChange") {
            this.fileChanges.delete(item.id);
        } else if (item.type === "mcpToolCall") {
            const pending = this.pendingMcpCalls.get(item.server);
            if (!pending) return;
            const index = pending.indexOf(item.id);
            if (index >= 0) pending.splice(index, 1);
            if (pending.length === 0) this.pendingMcpCalls.delete(item.server);
        }
    }
}
