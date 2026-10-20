import { expect, it } from "bun:test"

import { fromUserMessage } from "../codex/sessionConfig"
import { createTestAgent, CWD, THREAD_ID, turn } from "./harness"

const replies = [
  {
    questionItemId: '["request_user_input_async","call_a",0]',
    question: "Please focus Vibemon and keep it open.",
    answer: "已点"
  },
  {
    questionItemId: '["request_user_input_async","call_b",1]',
    question: "Which files?",
    answer: "A.txt\n中文 #2.txt <literal>"
  }
]
const envelope = (value: unknown) =>
  `<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`

it("replays every reply in order with readable text and structured metadata", async () => {
  const { thread } = await import("./harness")
  const t = createTestAgent()
  t.codex.respond("thread/list", () => ({
    data: [thread({ preview: envelope(replies).slice(0, 120) })],
    nextCursor: null,
    backwardsCursor: null
  }))
  t.codex.respond("thread/turns/list", () => ({
    data: [
      turn({
        items: [
          {
            type: "userMessage",
            id: "question-replies",
            clientId: null,
            content: [{ type: "text", text: envelope(replies), text_elements: [] }]
          }
        ]
      })
    ],
    nextCursor: null,
    backwardsCursor: null
  }))
  await t.initialize()
  expect((await t.agent.listSessions({ cwd: CWD })).sessions[0]?.title).toBe(replies[0]!.question)
  await t.agent.resumeSession({ sessionId: THREAD_ID, cwd: CWD, replayFrom: { type: "start" } })
  expect(t.client.updatesOf("user_message")[0]).toMatchObject({
    content: replies.map((reply) => ({
      type: "text",
      text: `${reply.question}\n${reply.answer}`,
      _meta: { codex: { questionReply: reply } }
    }))
  })
  await t.agent.closeSession({ sessionId: THREAD_ID })
})

it.each([
  "<send_user_message_question_reply>not JSON</send_user_message_question_reply>",
  envelope([]),
  envelope([replies[0], { question: "missing fields" }]),
  envelope([{ ...replies[0], answer: ["wrong type"] }]),
  `Example:\n${envelope(replies)}`,
  `\`\`\`\n${envelope(replies)}\n\`\`\``,
  envelope(replies).replace("</send_user_message_question_reply>", "")
])("retains unrecognized or malformed input without losing content: %s", (text) => {
  expect(fromUserMessage([{ type: "text", text, text_elements: [] }])).toEqual([{ type: "text", text }])
})

it("preserves empty answers, adjacent text and attachments", () => {
  const reply = { ...replies[0]!, answer: "" }
  expect(
    fromUserMessage([
      { type: "text", text: "Context", text_elements: [] },
      { type: "text", text: envelope([reply]), text_elements: [] },
      { type: "image", url: "data:image/png;base64,aGVsbG8=" }
    ])
  ).toEqual([
    { type: "text", text: "Context" },
    { type: "text", text: `${reply.question}\n`, _meta: { codex: { questionReply: reply } } },
    { type: "image", mimeType: "image/png", data: "aGVsbG8=" }
  ])
})

it("normalizes live insertion and native echoes without changing the submitted payload", async () => {
  const { TURN_ID } = await import("./harness")
  const { promptTitle } = await import("../codex/sessionConfig")
  const t = createTestAgent()
  await t.initialize()
  await t.openSession()
  const text = envelope(replies)
  const receipt = await t.agent.prompt({ sessionId: THREAD_ID, prompt: [{ type: "text", text }] })
  await t.settle()
  const expected = replies.map((reply) => ({
    type: "text" as const,
    text: `${reply.question}\n${reply.answer}`,
    _meta: { codex: { questionReply: reply } }
  }))
  expect(t.client.updatesOf("user_message")[0]?.content).toEqual(expected)
  expect(t.client.updatesOf("user_message")[0]?._meta?.["codex"]).toMatchObject({
    questionReplyParts: replies.map((reply) => ({ question: reply.question, text: reply.answer }))
  })
  expect(t.codex.calls("turn/start")[0]?.params).toMatchObject({ input: [{ type: "text", text }] })
  t.codex.emit({ method: "turn/started", params: { threadId: THREAD_ID, turn: turn() } })
  const item = {
    type: "userMessage" as const,
    id: "native-reply",
    clientId: receipt.messageId,
    content: [{ type: "text" as const, text, text_elements: [] }]
  }
  t.codex.emit({ method: "item/started", params: { threadId: THREAD_ID, turnId: TURN_ID, item, startedAtMs: 1000 } })
  await t.settle()
  expect(t.client.updatesOf("user_message").at(-1)?.content).toEqual(expected)
  expect(promptTitle([{ type: "text", text }])).toBe(replies[0]!.question)
  t.codex.emit({ method: "turn/completed", params: { threadId: THREAD_ID, turn: turn({ status: "completed" }) } })
  await t.settle()
  await t.agent.closeSession({ sessionId: THREAD_ID })
})
