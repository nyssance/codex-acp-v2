import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"

/** Recognize only complete Desktop reply envelopes; quoted examples and malformed data remain text. */
export function questionReplyContent(text: string): acp.ContentBlock[] | null {
  const envelope =
    /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text)
  if (!envelope) return null
  let replies: unknown
  try {
    replies = JSON.parse(envelope[1]!)
  } catch {
    return null
  }
  if (!Array.isArray(replies) || replies.length === 0) return null
  const content: acp.ContentBlock[] = []
  for (const reply of replies as unknown[]) {
    if (reply === null || typeof reply !== "object" || Array.isArray(reply)) return null
    const { questionItemId, question, answer } = reply as Record<string, unknown>
    if (typeof questionItemId !== "string" || typeof question !== "string" || typeof answer !== "string") return null
    content.push({
      type: "text",
      text: `${question}\n${answer}`,
      _meta: { codex: { questionReply: { questionItemId, question, answer } } }
    })
  }
  return content
}
