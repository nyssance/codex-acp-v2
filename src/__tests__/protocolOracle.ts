import * as acp from "@agentclientprotocol/sdk/experimental/v2";

/** Independent client model: validate standard payloads and apply ACP patch semantics. */
export class ProtocolOracle {
    readonly issues: string[] = [];
    readonly messages = new Map<string, string>();
    private readonly openTools = new Set<string>();
    private readonly terminals = new Set<string>();
    private readonly openTerminals = new Set<string>();
    private readonly tools = new Set<string>();

    accept(sessionId: string, update: acp.SessionUpdate): void {
        const validators = Object.entries(acp.SessionUpdate).filter(([name]) => name !== "isCustom");
        if (!validators.some(([, validate]) => validate(update))) {
            this.issues.push(`Invalid or nonstandard update: ${update.sessionUpdate}`);
            return;
        }
        if (acp.SessionUpdate.isToolCallUpdate(update)) {
            const key = `${sessionId}:${update.toolCallId}`;
            if (!this.tools.has(key)) {
                if (!update.name || !update.title || !update.kind) this.issues.push(`Incomplete first tool upsert: ${key}`);
                this.tools.add(key);
            }
        }
        if (acp.SessionUpdate.isToolCallUpdate(update)) {
            const key = `${sessionId}:${update.toolCallId}`;
            if (update.status === "pending" || update.status === "in_progress") this.openTools.add(key);
            else if (update.status != null) this.openTools.delete(key);
        }
        if (acp.SessionUpdate.isTerminalUpdate(update)) {
            const key = `${sessionId}:${update.terminalId}`;
            this.terminals.add(key);
            if (update.command != null) this.openTerminals.add(key);
            if (update.exitStatus != null) this.openTerminals.delete(key);
        }
        if (acp.SessionUpdate.isToolCallUpdate(update)) {
            for (const content of update.content ?? []) {
                if (content.type === "terminal" && !this.terminals.has(`${sessionId}:${content.terminalId}`)) this.issues.push(`Unknown terminal reference: ${content.terminalId}`);
            }
        }
        if (acp.SessionUpdate.isStateUpdate(update) && update.state === "idle") {
            for (const key of [...this.openTools, ...this.openTerminals]) {
                if (key.startsWith(`${sessionId}:`)) this.issues.push(`Still running at idle: ${key}`);
            }
        }
        if (acp.SessionUpdate.isAgentMessageChunk(update) && update.content.type === "text") {
            const key = `${sessionId}:${update.messageId}`;
            this.messages.set(key, (this.messages.get(key) ?? "") + update.content.text);
        }
        if (acp.SessionUpdate.isAgentMessage(update) && update.content !== undefined) {
            const text = (update.content ?? []).flatMap(content => content.type === "text" ? [content.text] : []).join("");
            this.messages.set(`${sessionId}:${update.messageId}`, text);
        }
    }
}
