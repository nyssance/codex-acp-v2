import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {ThreadItem} from "../app-server/v2";
import {terminalSnapshot, usesTerminal} from "./terminal";
import * as tool from "./toolCalls";
import {fromUserMessage} from "../codex/sessionConfig";
import {isInternalPlanMessageId, type CommandReceipt} from "../agent/commandReceipts";

/** Complete standard ACP snapshots, shared by history replay and missed-start recovery. */
export function itemSnapshot(item: ThreadItem, command?: CommandReceipt): acp.SessionUpdate[] {
    switch (item.type) {
        case "userMessage": {
            if (isInternalPlanMessageId(item.clientId)) return [];
            if (command) return [{sessionUpdate: "user_message", messageId: command.messageId, content: command.content}];
            const content = fromUserMessage(item.content);
            // The receipt id (`clientId`) wins so a replay names the message the client knows.
            return content.length > 0 ? [{sessionUpdate: "user_message", messageId: item.clientId ?? item.id, content}] : [];
        }
        case "agentMessage":
            return item.text.length > 0
                ? [{
                    sessionUpdate: "agent_message",
                    messageId: item.id,
                    content: [{type: "text", text: item.text}],
                    ...(item.phase ? {_meta: {codex: {phase: item.phase}}} : {}),
                }]
                : [];
        case "reasoning": {
            const parts = (item.summary.length > 0 ? item.summary : item.content).filter(part => part.length > 0);
            return parts.length > 0
                ? [{sessionUpdate: "agent_thought", messageId: item.id, content: parts.map(text => ({type: "text", text}))}]
                : [];
        }
        case "plan":
            return item.text.length > 0
                ? [{sessionUpdate: "plan_update", plan: {type: "markdown", planId: item.id, content: item.text}}]
                : [];
        case "fileChange":
            return [tool.fileChangeStarted(item)];
        case "commandExecution": {
            const updates: acp.SessionUpdate[] = [tool.commandStarted(item)];
            if (usesTerminal(item)) updates.unshift(terminalSnapshot(item));
            if (item.status !== "inProgress") updates.push(tool.commandCompleted(item));
            return updates;
        }
        case "mcpToolCall":
            return [tool.mcpToolCallStarted(item)];
        case "dynamicToolCall":
            return [{...tool.dynamicToolCallStarted(item), ...tool.dynamicToolCallCompleted(item)}];
        case "webSearch":
            return [tool.webSearchSnapshot(item)];
        case "imageView":
            return [tool.imageViewed(item)];
        case "imageGeneration":
            return [tool.imageGenerationSnapshot(item)];
        case "collabAgentToolCall":
            return [tool.collabToolCall(item, true)];
        case "subAgentActivity":
            return [tool.subAgentActivity(item, "completed", true)];
        case "contextCompaction":
            return [tool.compactionUpdate(item.id, "completed")];
        case "enteredReviewMode":
            return [];
        case "exitedReviewMode": {
            const text = item.review.trim();
            return text.length > 0 ? [{sessionUpdate: "agent_message", messageId: item.id, content: [{type: "text", text}]}] : [];
        }
        case "hookPrompt":
        case "functionCallOutput":
        case "sleep":
            return [];
    }
}

/** Review exit repeats the final answer on recent Codex versions; older versions emit only the exit. */
export function isDuplicateReview(item: ThreadItem, items: Iterable<ThreadItem>): boolean {
    if (item.type !== "exitedReviewMode") return false;
    const text = item.review.trim();
    return text.length > 0 && Array.from(items).some(candidate => candidate.type === "agentMessage"
        && candidate.phase !== "commentary" && candidate.text.trim() === text);
}
