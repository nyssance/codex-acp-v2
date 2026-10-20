import { expect, it } from "vitest"

import { createTestAgent, CWD, THREAD_ID, turn, TURN_ID } from "./harness"

it.each([false, true])("seals live work and preserves send time (client timestamp: %s)", async (clientTimestamp) => {
  const t = createTestAgent()
  await t.initialize()
  await t.openSession()
  const base = 1_790_000_000
  const receipt = await t.agent.prompt({
    sessionId: THREAD_ID,
    prompt: [{ type: "text", text: "hello" }],
    ...(clientTimestamp ? { _meta: { codex: { messageSentAt: base * 1000 - 2000 } } } : {})
  })
  await t.settle()
  t.codex.emit({ method: "turn/started", params: { threadId: THREAD_ID, turn: turn({ startedAt: base }) } })
  const user = {
    type: "userMessage" as const,
    id: "user",
    clientId: receipt.messageId,
    content: [{ type: "text" as const, text: "hello", text_elements: [] }]
  }
  t.codex.emit({
    method: "item/started",
    params: { threadId: THREAD_ID, turnId: TURN_ID, item: user, startedAtMs: base * 1000 + 200 }
  })
  t.codex.emit({
    method: "item/completed",
    params: { threadId: THREAD_ID, turnId: TURN_ID, item: user, completedAtMs: base * 1000 + 300 }
  })
  const answer = {
    type: "agentMessage" as const,
    id: "answer",
    text: "Done",
    phase: "final_answer" as const,
    memoryCitation: null,
    delivery: null,
    questions: null
  }
  t.codex.emit({
    method: "item/started",
    params: { threadId: THREAD_ID, turnId: TURN_ID, item: answer, startedAtMs: base * 1000 + 34000 }
  })
  await t.settle()
  expect(t.client.updatesOf("user_message").at(-1)?._meta?.["codex"]).toMatchObject({
    messageSentAt: base * 1000 + (clientTimestamp ? -2000 : 200),
    workDurationMs: clientTimestamp ? 36000 : 34000
  })
  t.codex.emit({
    method: "item/agentMessage/delta",
    params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "answer", delta: "Done" }
  })
  t.codex.emit({
    method: "item/completed",
    params: { threadId: THREAD_ID, turnId: TURN_ID, item: answer, completedAtMs: base * 1000 + 36200 }
  })
  t.codex.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: turn({ status: "completed", startedAt: base, completedAt: base + 37, durationMs: 37000 })
    }
  })
  await t.settle()
  expect(t.client.updatesOf("agent_message").at(-1)?._meta?.["codex"]).toMatchObject({
    workDurationMs: clientTimestamp ? 36000 : 34000,
    turnDurationMs: 37000,
    messageCompletedAt: base * 1000 + 36200,
    turnCompletedAt: (base + 37) * 1000
  })
  await t.agent.closeSession({ sessionId: THREAD_ID })
})

it("restored history exposes native total time and completion, never invented work timing", async () => {
  const t = createTestAgent()
  t.codex.respond("thread/turns/list", () => ({
    data: [
      turn({
        startedAt: 100,
        completedAt: 137,
        durationMs: 36500,
        items: [
          {
            type: "userMessage",
            id: "u",
            clientId: null,
            content: [{ type: "text", text: "hello", text_elements: [] }]
          },
          {
            type: "agentMessage",
            id: "a",
            text: "Done",
            phase: "final_answer",
            memoryCitation: null,
            delivery: null,
            questions: null
          }
        ]
      })
    ],
    nextCursor: null,
    backwardsCursor: null
  }))
  await t.initialize()
  await t.agent.resumeSession({ sessionId: THREAD_ID, cwd: CWD, replayFrom: { type: "start" } })
  expect(t.client.updatesOf("user_message")[0]?._meta?.["codex"]).toMatchObject({ messageSentAt: 100000 })
  const meta = t.client.updatesOf("agent_message")[0]?._meta?.["codex"]
  expect(meta).toMatchObject({ historyReplay: true, turnCompletedAt: 137000, turnDurationMs: 36500 })
  expect(meta).not.toHaveProperty("workDurationMs")
  await t.agent.closeSession({ sessionId: THREAD_ID })
})
