import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"

/** Receipt adoption retains optimistic content; keep structured replies at message level too. */
export function withQuestionReplyParts(
  content: acp.ContentBlock[],
  meta?: Record<string, unknown>
): Record<string, unknown> | undefined {
  let found = false
  const parts = content.flatMap((block) => {
    if (!acp.ContentBlock.isText(block)) return []
    const reply = (
      block._meta?.["codex"] as
        { questionReply?: { questionItemId: string; question: string; answer: string } } | undefined
    )?.questionReply
    if (!reply) return [{ text: block.text }]
    found = true
    return [{ questionItemId: reply.questionItemId, question: reply.question, text: reply.answer }]
  })
  return found ? { ...meta, codex: { ...(meta?.["codex"] as object), questionReplyParts: parts } } : meta
}

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
