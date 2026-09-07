import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {ThreadItem} from "../app-server/v2";
import {terminalSnapshot, usesTerminal} from "./terminal";
import * as tool from "./toolCalls";
import {fromUserInput} from "../codex/sessionConfig";

/** Complete standard ACP snapshots, shared by history replay and missed-start recovery. */
export function itemSnapshot(item: ThreadItem): acp.SessionUpdate[] {
    switch (item.type) {
        case "userMessage": {
            const content = item.content.flatMap(fromUserInput);
            return content.length > 0 ? [{sessionUpdate: "user_message", messageId: item.id, content}] : [];
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
