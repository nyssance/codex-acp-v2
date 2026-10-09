import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {pathToFileURL} from "node:url";
import type {ThreadItem, UserInput} from "../app-server/v2";
import {itemSnapshot} from "../bridge/itemSnapshot";
import {withTurnId} from "../bridge/turnMetadata";

export interface HistoryOmission { itemId: string; field: string; reason: string }
export interface HistoryProjection { updates: acp.SessionUpdate[]; omissions: HistoryOmission[] }

function inputBlock(input: UserInput): acp.ContentBlock {
    switch (input.type) {
        case "text": return {type: "text", text: input.text, ...(input.text_elements.length ? {_meta: {codex: {textElements: input.text_elements}}} : {})};
        case "image": return {type: "resource_link", name: "Image", uri: "url" in input ? input.url : `codex-file:${encodeURIComponent(input.fileId)}`, _meta: {codex: {inputType: input.type, ...(input.detail ? {detail: input.detail} : {}), ...("fileId" in input ? {fileId: input.fileId} : {})}}};
        case "audio": return {type: "resource_link", name: "Audio", uri: input.url, _meta: {codex: {inputType: input.type}}};
        case "localImage":
        case "localAudio": return {type: "resource_link", name: input.type === "localImage" ? "Image" : "Audio", uri: input.path.startsWith("file://") ? input.path : pathToFileURL(input.path).href, _meta: {codex: {inputType: input.type, ...("detail" in input && input.detail ? {detail: input.detail} : {})}}};
        case "skill":
        case "mention": return {type: "resource_link", name: input.name, uri: input.path.startsWith("file://") ? input.path : pathToFileURL(input.path).href, _meta: {codex: {inputType: input.type}}};
    }
}

/** A history-specific projection: live replay behavior is deliberately unchanged. */
export function projectHistoryItem(item: ThreadItem, turnId: string, startedAt?: number | null): HistoryProjection {
    const omissions: HistoryOmission[] = [];
    let updates: acp.SessionUpdate[];
    if (item.type === "userMessage") {
        updates = [{sessionUpdate: "user_message", messageId: item.clientId ?? item.id, content: item.content.map(inputBlock)}];
    } else {
        updates = itemSnapshot(item);
        if (!updates.length) omissions.push({itemId: item.id, field: "*", reason: "no_acp_representation"});
        if (item.type === "reasoning" && item.summary.length && item.content.length) omissions.push({itemId: item.id, field: "content", reason: "summary_selected"});
        if (item.type === "agentMessage") {
            for (const field of ["memoryCitation", "delivery", "questions"] as const) {
                if (item[field] !== null) omissions.push({itemId: item.id, field, reason: "no_acp_representation"});
            }
        }
    }
    return {updates: updates.map(update => withTurnId(update, turnId, startedAt)), omissions};
}
