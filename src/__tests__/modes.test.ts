import { describe, expect, it } from "bun:test"
import { AGENT_MODES, initialAgentMode, withWritableRoots } from "../codex/modes"
import { createTestAgent, CWD, THREAD_ID } from "./harness"

describe("permission presets", () => {
  it("keeps the default and rejects invalid process settings", () => {
    expect(initialAgentMode({}).id).toBe("agent")
    expect(() => initialAgentMode({ INITIAL_AGENT_MODE: "typo" })).toThrow("Unknown INITIAL_AGENT_MODE")
    const readOnly = AGENT_MODES.find((mode) => mode.id === "read-only")!
    expect(withWritableRoots(readOnly.sandboxPolicy, ["/extra"])).toEqual({ type: "readOnly", networkAccess: false })
  })

  it.each([
    ["read-only", "read-only", "readOnly"],
    ["workspace-write", "workspace-write", "workspaceWrite"]
  ])("enforces %s when starting and prompting", async (id, sandbox, type) => {
    const t = createTestAgent()
    await t.initialize()
    const opened = await t.agent.newSession({ cwd: CWD, _meta: { codex: { mode: id } } })
    expect(t.codex.lastParams("thread/start")).toMatchObject({ sandbox, approvalsReviewer: "user" })
    expect(opened.configOptions?.find((option) => option.configId === "mode")).toMatchObject({ currentValue: id })
    await t.agent.prompt({ sessionId: THREAD_ID, prompt: [{ type: "text", text: "inspect" }] })
    await t.settle()
    expect(t.codex.lastParams("turn/start")).toMatchObject({ sandboxPolicy: { type }, approvalsReviewer: "user" })
  })
})
