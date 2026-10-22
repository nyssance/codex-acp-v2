import { expect, it } from "bun:test"

import { projectHistoryItem } from "../agent/historyProjection"
import type { ThreadItem } from "../app-server/v2"
import { AgentDirectory } from "../bridge/agentDirectory"
import { createTestAgent, CWD, itemCompleted, itemStarted, THREAD_ID, turn, TURN_ID } from "./harness"

const item: Extract<ThreadItem, { type: "agentMessage" }> = {
  type: "agentMessage",
  id: "async-call",
  text: "Which environment?",
  phase: "final_answer",
  memoryCitation: null,
  delivery: "async",
  questions: [
    { title: "Which environment?", options: ["Local", "Remote"] },
    { title: "Any details?", options: null }
  ]
}

it("keeps live asynchronous questions structured without waiting for an elicitation", async () => {
  const t = createTestAgent()
  await t.initialize()
  await t.openSession()
  await t.agent.prompt({ sessionId: THREAD_ID, prompt: [{ type: "text", text: "go" }] })
  await t.settle()
  t.client.clear()
  itemStarted(t.codex, item)
  itemCompleted(t.codex, item)
  await t.settle()
  expect(t.client.updatesOf("agent_message")).toHaveLength(1)
  expect(t.client.updatesOf("agent_message")[0]).toMatchObject({
    messageId: item.id,
    _meta: { codex: { turnId: TURN_ID, delivery: "async", questions: item.questions } }
  })
  expect(t.client.updatesOf("state_update")).toHaveLength(0)
  const reply = [
    {
      questionItemId: JSON.stringify(["request_user_input_async", item.id, 0]),
      question: "Which environment?",
      answer: "Remote"
    }
  ]
  const text = `<send_user_message_question_reply>\n${JSON.stringify(reply)}\n</send_user_message_question_reply>`
  const receipt = await t.agent.prompt({ sessionId: THREAD_ID, prompt: [{ type: "text", text }] })
  expect(t.codex.calls("turn/steer").at(-1)?.params).toMatchObject({
    threadId: THREAD_ID,
    input: [{ type: "text", text }]
  })
  itemStarted(t.codex, {
    type: "userMessage",
    id: "reply",
    clientId: receipt.messageId,
    content: [{ type: "text", text, text_elements: [] }]
  })
  await t.settle()
  expect(t.client.updatesOf("user_message").at(-1)).toMatchObject({
    _meta: {
      codex: {
        questionReplyParts: [
          { questionItemId: reply[0]!.questionItemId, question: "Which environment?", text: "Remote" }
        ]
      }
    }
  })
  await t.agent.closeSession({ sessionId: THREAD_ID })
})

it("preserves question metadata on replay and explicit history, including question-only messages", async () => {
  const t = createTestAgent()
  const questionOnly = { ...item, text: "" }
  t.codex.respond("thread/turns/list", () => ({
    data: [turn({ items: [questionOnly] })],
    nextCursor: null,
    backwardsCursor: null
  }))
  await t.initialize()
  await t.agent.resumeSession({ sessionId: THREAD_ID, cwd: CWD, replayFrom: { type: "start" } })
  expect(t.client.updatesOf("agent_message")[0]).toMatchObject({
    messageId: item.id,
    _meta: { codex: { delivery: "async", questions: item.questions } }
  })
  const history = await projectHistoryItem(
    questionOnly,
    new AgentDirectory(async () => {
      throw new Error("Unexpected lookup")
    }),
    TURN_ID
  )
  expect(history.omissions).toEqual([])
  expect(history.updates[0]).toMatchObject({ _meta: { codex: { delivery: "async", questions: item.questions } } })
  await t.agent.closeSession({ sessionId: THREAD_ID })
})

it("keeps every reply correlated when projecting paginated native history", async () => {
  const replies = item.questions!.map((question, index) => ({
    questionItemId: JSON.stringify(["request_user_input_async", item.id, index]),
    question: question.title,
    answer: index === 0 ? "Remote" : "Details\n<literal text>"
  }))
  const history = await projectHistoryItem(
    {
      type: "userMessage",
      id: "native-reply",
      clientId: "reply",
      content: [
        {
          type: "text",
          text: `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`,
          text_elements: []
        }
      ]
    },
    new AgentDirectory(async () => {
      throw new Error("Unexpected lookup")
    }),
    TURN_ID
  )
  expect(history.omissions).toEqual([])
  expect(history.updates).toEqual([
    {
      sessionUpdate: "user_message",
      messageId: "reply",
      content: replies.map((reply) => ({
        type: "text",
        text: `${reply.question}\n${reply.answer}`,
        _meta: { codex: { questionReply: reply } }
      })),
      _meta: { codex: { turnId: TURN_ID } }
    }
  ])
})
