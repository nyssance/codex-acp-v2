import { pathToFileURL } from "node:url"

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"

import type { ThreadItem, UserInput } from "../app-server/v2"
import type { AgentDirectory } from "../bridge/agentDirectory"
import { itemSnapshot } from "../bridge/itemSnapshot"
import { withTurnId } from "../bridge/turnMetadata"
import { questionReplyContent } from "../codex/questionReplies"
import { fromUserInput, fromUserMessage } from "../codex/sessionConfig"
import { hydrateUserImages, localImageContent } from "../codex/userImages"
import { type CommandReceipt, isInternalPlanMessageId } from "./commandReceipts"

export interface HistoryOmission {
  itemId: string
  field: string
  reason: string
}
export interface HistoryProjection {
  updates: acp.SessionUpdate[]
  omissions: HistoryOmission[]
}

function inputBlock(input: UserInput): acp.ContentBlock {
  switch (input.type) {
    case "text":
      return {
        type: "text",
        text: input.text,
        ...(input.text_elements.length ? { _meta: { codex: { textElements: input.text_elements } } } : {})
      }
    case "image":
      return {
        ...fromUserInput(input)[0]!,
        _meta: {
          codex: {
            inputType: input.type,
            ...(input.detail ? { detail: input.detail } : {}),
            ...("fileId" in input ? { fileId: input.fileId } : {})
          }
        }
      }
    case "audio":
      return { type: "resource_link", name: "Audio", uri: input.url, _meta: { codex: { inputType: input.type } } }
    case "localImage": {
      const block = localImageContent(input.path)
      block._meta = { codex: { inputType: input.type, ...(input.detail ? { detail: input.detail } : {}) } }
      return block
    }
    case "localAudio":
      return {
        type: "resource_link",
        name: "Audio",
        uri: input.path.startsWith("file://") ? input.path : pathToFileURL(input.path).href,
        _meta: { codex: { inputType: input.type } }
      }
    case "skill":
    case "mention":
      return {
        type: "resource_link",
        name: input.name,
        uri: input.path.startsWith("file://") ? input.path : pathToFileURL(input.path).href,
        _meta: { codex: { inputType: input.type } }
      }
  }
}

/** A history-specific projection: live replay behavior is deliberately unchanged. */
export async function projectHistoryItem(
  item: ThreadItem,
  agents: AgentDirectory,
  turnId: string,
  startedAt?: number | null,
  command?: CommandReceipt | null,
  signal: AbortSignal = new AbortController().signal
): Promise<HistoryProjection> {
  const omissions: HistoryOmission[] = []
  let updates: acp.SessionUpdate[]
  if (item.type === "userMessage") {
    if (isInternalPlanMessageId(item.clientId)) {
      updates = []
      omissions.push({ itemId: item.id, field: "*", reason: "internal_command" })
    } else {
      updates = [
        {
          sessionUpdate: "user_message",
          messageId: command?.messageId ?? item.clientId ?? item.id,
          content:
            command?.content ??
            (await hydrateUserImages(
              fromUserMessage(item.content, (input) =>
                input.type === "text" ? (questionReplyContent(input.text) ?? [inputBlock(input)]) : [inputBlock(input)]
              ),
              signal
            ))
        }
      ]
    }
  } else {
    updates = itemSnapshot(item, agents)
    if (!updates.length) omissions.push({ itemId: item.id, field: "*", reason: "no_acp_representation" })
    if (item.type === "reasoning" && item.summary.length && item.content.length)
      omissions.push({ itemId: item.id, field: "content", reason: "summary_selected" })
    if (item.type === "agentMessage") {
      for (const field of ["memoryCitation"] as const) {
        if (item[field] !== null) omissions.push({ itemId: item.id, field, reason: "no_acp_representation" })
      }
    }
  }
  return { updates: updates.map((update) => withTurnId(update, turnId, startedAt)), omissions }
}
