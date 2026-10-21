import { describe, expect, it } from "bun:test"

import { parseSessionRetryParams } from "../agent/CodexAgent"
import { historyUpdates } from "../agent/history"
import { turnErrorUpdate } from "../agent/turnErrors"
import { noAgents } from "./fixtures"
import { createTestAgent, expectRejects, thread, THREAD_ID, turn, turnCompleted, waitFor } from "./harness"

const error = {
  message: "Selected model is at capacity. Please try a different model.",
  codexErrorInfo: "serverOverloaded" as const,
  additionalDetails: null,
  misalignment: null
}

async function ready() {
  const t = createTestAgent()
  await t.initialize()
  await t.openSession()
  t.codex.respond("thread/turns/list", () => ({
    data: [turn({ id: "failed", status: "failed", error })],
    nextCursor: null
  }))
  t.codex.respond("turn/start", () => ({ turn: turn({ id: "retry", status: "inProgress" }) }))
  return t
}

describe("capacity continuation", () => {
  it.each(["manual", "automatic"] as const)(
    "%s retry accepts once, sends empty input, and uses normal completion",
    async (trigger) => {
      const t = await ready()
      expect(await t.agent.retrySession({ sessionId: THREAD_ID, turnId: "failed", trigger })).toEqual({})
      await waitFor(() => expect(t.codex.calls("turn/start")).toHaveLength(1))
      expect(t.codex.lastParams("turn/start")).toMatchObject({
        threadId: THREAD_ID,
        input: [],
        clientUserMessageId: null,
        turnTrigger: `capacity_retry_${trigger}`
      })
      expect(t.client.updatesOf("user_message")).toHaveLength(0)
      expect(t.client.states()).toEqual(["running"])
      await expectRejects(t.agent.retrySession({ sessionId: THREAD_ID, turnId: "failed", trigger }), -32600)
      turnCompleted(t.codex, { id: "retry", status: "completed" })
      await t.settle()
      expect(t.client.states()).toEqual(["running", "idle"])
    }
  )

  it("rejects an outdated failure and a policy error before starting another turn", async () => {
    const t = await ready()
    await expectRejects(t.agent.retrySession({ sessionId: THREAD_ID, turnId: "older", trigger: "manual" }), -32600)
    t.codex.respond("thread/turns/list", () => ({
      data: [turn({ id: "failed", status: "failed", error: { ...error, codexErrorInfo: "cyberPolicy" } })],
      nextCursor: null
    }))
    await expectRejects(t.agent.retrySession({ sessionId: THREAD_ID, turnId: "failed", trigger: "automatic" }), -32600)
    expect(t.codex.calls("turn/start")).toHaveLength(0)
    expect(t.client.states()).toEqual([])
  })

  it("accepts native systemError as terminal, while refusing active native work", async () => {
    const t = await ready()
    t.codex.respond("thread/read", () => ({ thread: thread({ status: { type: "active", activeFlags: [] } }) }))
    await expectRejects(t.agent.retrySession({ sessionId: THREAD_ID, turnId: "failed", trigger: "manual" }), -32600)
    expect(t.codex.calls("turn/start")).toHaveLength(0)
    t.codex.respond("thread/read", () => ({ thread: thread({ status: { type: "systemError" } }) }))
    await t.agent.retrySession({ sessionId: THREAD_ID, turnId: "failed", trigger: "manual" })
    await waitFor(() => expect(t.codex.calls("turn/start")).toHaveLength(1))
    turnCompleted(t.codex, { id: "retry", status: "completed" })
    await t.settle()
    expect(t.client.states()).toEqual(["running", "idle"])
  })

  it("serializes native validation with prompts and emits a stable error if the continuation fails", async () => {
    const t = await ready()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    t.codex.respond("thread/turns/list", async () => {
      await gate
      return { data: [turn({ id: "failed", status: "failed", error })], nextCursor: null }
    })
    const retry = t.agent.retrySession({ sessionId: THREAD_ID, turnId: "failed", trigger: "manual" })
    await expectRejects(t.agent.prompt({ sessionId: THREAD_ID, prompt: [{ type: "text", text: "new work" }] }), -32600)
    finish()
    await retry
    await waitFor(() => expect(t.codex.calls("turn/start")).toHaveLength(1))
    turnCompleted(t.codex, { id: "retry", status: "failed", error })
    await t.settle()
    expect(t.client.updatesOf("agent_message_chunk").at(-1)).toMatchObject({
      messageId: "codex-error:retry",
      _meta: { codex: { turnId: "retry", error: { category: "overloaded", retryable: true } } }
    })
    expect(t.client.updatesOf("state_update").at(-1)).toMatchObject({ state: "idle", stopReason: "error" })
  })

  it("restores the same terminal diagnostic in full history, summaries, resume and forks", async () => {
    const t = await ready()
    const expected = turnErrorUpdate("failed", error)
    const page = await t.agent.sessionHistory({ sessionId: THREAD_ID, mode: "browse", itemsView: "full" })
    const summary = await t.agent.sessionHistory({ sessionId: THREAD_ID, mode: "browse", itemsView: "summary" })
    expect(page.turns[0]?.updates.at(-1)).toEqual(expected)
    expect(summary.turns[0]?.updates.at(-1)).toEqual(expected)
    const replay = historyUpdates([turn({ id: "failed", status: "failed", error })], noAgents)
    expect(replay.at(-1)).toMatchObject(expected)
  })

  it("validates retry inputs at the extension boundary", () => {
    for (const value of [
      null,
      {},
      { sessionId: "s", turnId: "", trigger: "manual" },
      { sessionId: "s", turnId: "t", trigger: "always" }
    ])
      expect(() => parseSessionRetryParams(value)).toThrow()
    expect(parseSessionRetryParams({ sessionId: "s", turnId: "t", trigger: "automatic" })).toEqual({
      sessionId: "s",
      turnId: "t",
      trigger: "automatic"
    })
  })

  it("keeps a continuation's structured plan separate from the failed turn's plan", async () => {
    const t = await ready()
    t.codex.respond("turn/start", () => ({ turn: turn({ id: "failed", status: "inProgress" }) }))
    await t.agent.prompt({ sessionId: THREAD_ID, prompt: [{ type: "text", text: "Plan the task" }] })
    await t.settle()
    const plan = (turnId: string) =>
      t.codex.emit({
        method: "turn/plan/updated",
        params: { threadId: THREAD_ID, turnId, explanation: null, plan: [{ step: "Inspect", status: "inProgress" }] }
      })
    plan("failed")
    turnCompleted(t.codex, { id: "failed", status: "failed", error })
    await t.settle()
    t.codex.respond("turn/start", () => ({ turn: turn({ id: "retry", status: "inProgress" }) }))
    await t.agent.retrySession({ sessionId: THREAD_ID, turnId: "failed", trigger: "manual" })
    await t.settle()
    plan("retry")
    turnCompleted(t.codex, { id: "retry", status: "completed" })
    await t.settle()
    expect(t.client.updatesOf("plan_update").map((update) => update.plan.planId)).toEqual([
      "codex-turn-plan:failed",
      "codex-turn-plan:retry"
    ])
  })
})
