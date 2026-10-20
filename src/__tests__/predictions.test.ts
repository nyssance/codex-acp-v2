import { expect, test } from "vitest"

import { parsePredictionParams } from "../agent/CodexAgent"
import { createTestAgent, THREAD_ID, threadResponse, turn, TURN_ID } from "./harness"

async function setup() {
  const fixture = createTestAgent()
  await fixture.initialize()
  await fixture.openSession()
  fixture.codex.respond("thread/turns/list", () => ({ data: [turn()], nextCursor: null, backwardsCursor: null }))
  fixture.codex.respond("thread/fork", () => threadResponse({ id: "prediction", ephemeral: true }))
  return fixture
}

for (const suggestion of ["Run the tests", null])
  test(`isolates temporary fork events and publishes only the parsed result: ${suggestion}`, async () => {
    const { agent, codex, client, settle } = await setup()
    codex.respond("turn/start", () => {
      codex.emit({
        method: "thread/started",
        params: { thread: threadResponse({ id: "prediction", ephemeral: true }).thread }
      })
      codex.emit({ method: "turn/started", params: { threadId: "prediction", turn: turn({ status: "inProgress" }) } })
      codex.emit({
        method: "item/completed",
        params: {
          threadId: "prediction",
          turnId: TURN_ID,
          completedAtMs: 1,
          item: {
            type: "agentMessage",
            id: "answer",
            text: JSON.stringify({ suggestion }),
            phase: "final_answer",
            memoryCitation: null,
            delivery: null,
            questions: null
          }
        }
      })
      codex.emit({ method: "turn/completed", params: { threadId: "prediction", turn: turn() } })
      return { turn: turn() }
    })
    expect(await agent.requestPrediction({ sessionId: THREAD_ID, sourceTurnId: TURN_ID })).toEqual({})
    await settle()
    expect(codex.lastParams("thread/fork")).toEqual({
      threadId: THREAD_ID,
      experimentalPredictionMode: true,
      ephemeral: true,
      excludeTurns: true,
      threadSource: "composer_predictions"
    })
    expect(codex.lastParams("thread/unsubscribe")).toEqual({ threadId: "prediction" })
    expect(client.updates()).toHaveLength(1)
    expect(client.updates()[0]).toMatchObject({
      sessionId: THREAD_ID,
      sessionUpdate: "session_info_update",
      _meta: { codex: { prediction: { sourceTurnId: TURN_ID, result: { type: "completed", text: suggestion } } } }
    })
    expect(client.states()).toEqual([])
    expect(client.requests).toEqual([])
  })

test("cleans up a failed prediction and reports failure on its parent", async () => {
  const { agent, codex, client, settle } = await setup()
  codex.respond("turn/start", () => {
    throw new Error("generation failed")
  })
  await agent.requestPrediction({ sessionId: THREAD_ID, sourceTurnId: TURN_ID })
  await settle()
  expect(codex.lastParams("thread/unsubscribe")).toEqual({ threadId: "prediction" })
  expect(client.updates()[0]).toMatchObject({ _meta: { codex: { prediction: { result: { type: "failed" } } } } })
  expect(client.states()).toEqual([])
})

test("closing the source while a fork is starting cleans it up without a late update", async () => {
  const { agent, codex, client, settle } = await setup()
  let release!: (value: ReturnType<typeof threadResponse>) => void
  codex.respond(
    "thread/fork",
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  await agent.requestPrediction({ sessionId: THREAD_ID, sourceTurnId: TURN_ID })
  await agent.closeSession({ sessionId: THREAD_ID })
  release(threadResponse({ id: "prediction", ephemeral: true }))
  await settle()
  expect(codex.calls("turn/start")).toHaveLength(0)
  expect(codex.lastParams("thread/unsubscribe")).toEqual({ threadId: "prediction" })
  expect(client.updates()).toEqual([])
})

test("rejects invalid, missing, stale and running sources before creating a fork", async () => {
  for (const params of [null, {}, { sessionId: "s", sourceTurnId: "" }, { sessionId: "s", sourceTurnId: 1 }])
    expect(() => parsePredictionParams(params)).toThrow()
  const { agent, codex } = await setup()
  await expect(agent.requestPrediction({ sessionId: "missing", sourceTurnId: TURN_ID })).rejects.toThrow(
    "Unknown session"
  )
  await expect(agent.requestPrediction({ sessionId: THREAD_ID, sourceTurnId: "old" })).rejects.toThrow(
    "latest completed turn"
  )
  await agent.prompt({ sessionId: THREAD_ID, prompt: [{ type: "text", text: "Hello" }] })
  await expect(agent.requestPrediction({ sessionId: THREAD_ID, sourceTurnId: TURN_ID })).rejects.toThrow(
    "Wait for the current turn"
  )
  expect(codex.calls("thread/fork")).toHaveLength(0)
})

test("a new parent prompt cancels an in-flight prediction without changing the parent's lifecycle", async () => {
  const { agent, codex, client, settle } = await setup()
  await agent.requestPrediction({ sessionId: THREAD_ID, sourceTurnId: TURN_ID })
  await settle()
  expect(client.updates()).toEqual([])
  expect(client.states()).toEqual([])
  await agent.prompt({ sessionId: THREAD_ID, prompt: [{ type: "text", text: "Another question" }] })
  await settle()
  expect(codex.lastParams("thread/unsubscribe")).toEqual({ threadId: "prediction" })
  expect(client.updatesOf("session_info_update")).toEqual([])
  expect(client.states()).toEqual(["running"])
})

test("malformed prediction output is cleaned up without entering chat history", async () => {
  const { agent, codex, client, settle } = await setup()
  codex.respond("turn/start", () => {
    codex.emit({ method: "turn/completed", params: { threadId: "prediction", turn: turn() } })
    return { turn: turn() }
  })
  await agent.requestPrediction({ sessionId: THREAD_ID, sourceTurnId: TURN_ID })
  await settle()
  expect(codex.lastParams("thread/unsubscribe")).toEqual({ threadId: "prediction" })
  expect(client.updates()).toHaveLength(1)
  expect(client.updates()[0]).toMatchObject({
    sessionId: THREAD_ID,
    _meta: { codex: { prediction: { result: { type: "failed" } } } }
  })
})
