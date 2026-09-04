import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {Thread, ThreadItem} from "../app-server/v2";
import {terminalSnapshot, usesTerminal} from "../bridge/terminal";
import * as tool from "../bridge/toolCalls";
import {fromUserInput} from "../codex/sessionConfig";

/**
 * Renders a loaded Codex thread as the session updates a client would have seen
 * live, so `session/resume` with `replayFrom: start` and `session/fork` restore
 * the transcript before the response resolves.
 */
export function historyUpdates(thread: Thread): acp.SessionUpdate[] {
    const updates: acp.SessionUpdate[] = [];
    for (const turn of thread.turns) {
        for (const item of turn.items) {
            updates.push(...itemHistory(item));
        }
    }
    return updates;
}

/** Title from the first user message, for threads Codex has not named yet. */
export function historyTitle(thread: Thread): string | null {
    const explicit = thread.name?.trim();
    if (explicit) return explicit;
    for (const turn of thread.turns) {
        for (const item of turn.items) {
            if (item.type !== "userMessage") continue;
            const text = item.content
                .filter((input): input is Extract<typeof input, {type: "text"}> => input.type === "text")
                .map(input => input.text.trim())
                .find(part => part.length > 0);
            if (text) return firstLine(text);
        }
    }
    const preview = thread.preview.trim();
    return preview.length > 0 ? firstLine(preview) : null;
}

function firstLine(text: string): string {
    const line = text.split(/\r?\n/).map(part => part.trim()).find(part => part.length > 0) ?? text;
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function itemHistory(item: ThreadItem): acp.SessionUpdate[] {
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
            if (usesTerminal(item)) updates.push(terminalSnapshot(item));
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
