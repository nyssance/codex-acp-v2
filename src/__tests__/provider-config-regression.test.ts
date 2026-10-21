import { expect, it } from "bun:test"

import type { TurnStartParams } from "../app-server/v2"
import { createTestAgent, model, THREAD_ID, turnCompleted } from "./harness"

const gateway = {
  providerId: "openai",
  apiType: "openai" as const,
  baseUrl: "https://provider.example/v1",
  _meta: { codex: { id: "custom", mode: "catalog" }, alwith: { models: [{ id: "foreign-model" }] } }
}

it("does not advertise or send native effort settings for an unknown gateway model", async () => {
  const t = createTestAgent()
  await t.initialize()
  await t.agent.setProvider(gateway)
  await t.openSession()
  const result = await t.agent.setSessionConfigOption({
    sessionId: THREAD_ID,
    configId: "model",
    type: "id",
    value: "gateway:custom:foreign-model"
  })
  expect(result.configOptions.some((option) => option.configId === "effort")).toBe(false)
  await t.agent.prompt({ sessionId: THREAD_ID, prompt: [{ type: "text", text: "/status" }] })
  await t.settle()
  expect(JSON.stringify(t.client.updates())).not.toContain("foreign-model (medium)")
  await expect(
    t.agent.setSessionConfigOption({ sessionId: THREAD_ID, configId: "effort", type: "id", value: "high" })
  ).rejects.toThrow(/does not support/)
  await t.agent.prompt({ sessionId: THREAD_ID, prompt: [{ type: "text", text: "hello" }] })
  await t.settle()
  expect(t.codex.lastParams<TurnStartParams>("turn/start").effort).toBeNull()
  turnCompleted(t.codex)
  await t.settle()
})

it("matches gateway capabilities by upstream model instead of the first native model", async () => {
  const hidden = model({
    id: "foreign-model",
    model: "foreign-model",
    hidden: true,
    isDefault: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "high", description: "Deep" }
    ]
  })
  const t = createTestAgent()
  t.codex.respond("model/list", (params) => ({
    data: params.includeHidden ? [model(), hidden] : [model()],
    nextCursor: null
  }))
  await t.initialize()
  await t.agent.setProvider(gateway)
  await t.openSession()
  const result = await t.agent.setSessionConfigOption({
    sessionId: THREAD_ID,
    configId: "model",
    type: "id",
    value: "gateway:custom:foreign-model"
  })
  expect(result.configOptions.find((option) => option.configId === "effort")).toMatchObject({
    currentValue: "high",
    options: [{ value: "low" }, { value: "high" }]
  })
})

it("executes status locally when a file mention precedes the command text", async () => {
  const t = createTestAgent()
  await t.initialize()
  await t.openSession()
  await t.agent.prompt({
    sessionId: THREAD_ID,
    prompt: [
      { type: "resource_link", name: "probe.txt", uri: "file:///tmp/probe.txt" },
      { type: "text", text: "/status" }
    ]
  })
  await t.settle()
  expect(t.codex.calls("turn/start")).toHaveLength(0)
  expect(t.client.states()).toEqual(["running", "idle"])
  expect(JSON.stringify(t.client.updates())).toContain("**Model:**")
})

it("keeps leading mentions and replaces only the plan command text", async () => {
  const t = createTestAgent()
  await t.initialize()
  await t.openSession()
  await t.agent.prompt({
    sessionId: THREAD_ID,
    prompt: [
      { type: "resource_link", name: "probe.txt", uri: "file:///tmp/probe.txt" },
      { type: "text", text: "/plan inspect this file" }
    ]
  })
  await t.settle()
  expect(t.codex.lastParams<TurnStartParams>("turn/start").input).toEqual([
    { type: "text", text: "[@probe.txt](file:///tmp/probe.txt)", text_elements: [] },
    { type: "text", text: "inspect this file", text_elements: [] }
  ])
  turnCompleted(t.codex)
  await t.settle()
})
