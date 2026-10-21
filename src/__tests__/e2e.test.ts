import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { pathToFileURL } from "node:url"

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"

import type { SessionHistoryItemsResponse, SessionHistoryResponse } from "../agent/sessionHistory"
import { type FakeGateway, startFakeGateway } from "./fakeGateway"
import { ProtocolOracle } from "./protocolOracle"

/**
 * Live wire suite: drives the agent over stdio against a real `codex app-server`.
 * Enable with `RUN_E2E_TESTS=true`; provide `CODEX_API_KEY` or `OPENAI_API_KEY`
 * unless the machine is already logged in to ChatGPT. Prompts are phrased so the
 * model's behaviour is as deterministic as a live model allows.
 */
const RUN = process.env["RUN_E2E_TESTS"] === "true"
const ROOT = path.resolve(__dirname, "../..")
const TURN_TIMEOUT_MS = 120_000

type Message = {
  jsonrpc: "2.0"
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data: { reason?: string } }
}
// Wire frames are read loosely on purpose (only the fields the assertions touch); the unit suite covers exact shapes.
type Meta = {
  codex?: {
    turnId?: string
    notice?: unknown
    nativeSessionId?: string
    forkedFromId?: string
    forkedAtTurnId?: string
  }
}
type Update = {
  sessionId: string
  sessionUpdate: string
  state?: string
  stopReason?: string
  usage?: { totalTokens: number }
  messageId?: string
  title?: string
  content?: Array<{ type: string; text?: string }>
  _meta?: Meta
}
type PermissionRequest = { sessionId: string; title: string; options: Array<{ kind: string; optionId: string }> }
type ConfigOption = { configId: string; currentValue: string }
type SessionResponse = { sessionId: string; configOptions: ConfigOption[]; _meta: Meta }
interface Responses {
  initialize: {
    protocolVersion: number
    capabilities: { providers: unknown; _meta: { codex: { sessionHistory: unknown } } }
  }
  "auth/login": unknown
  "session/new": SessionResponse
  "session/resume": SessionResponse
  "session/fork": SessionResponse
  "session/prompt": { messageId: string }
  "session/set_config_option": { configOptions: ConfigOption[] }
  "session/list": { sessions: Array<{ sessionId: string; title?: string; _meta: Meta }> }
  "session/close": unknown
  "session/delete": unknown
  "providers/set": unknown
  "providers/disable": unknown
  "providers/list": { providers: Array<{ current: { baseUrl: string } }> }
  "_codex/session_history": SessionHistoryResponse
  "_codex/session_history_items": SessionHistoryItemsResponse
  "_codex/session_archive": unknown
  "_codex/session_retry": unknown
}
/** The oracle validates the raw wire frame against the ACP schema; the suite only reads it loosely. */
const asSessionUpdate = (update: Update): acp.SessionUpdate => update as unknown as acp.SessionUpdate

class StdioClient {
  private readonly child: ChildProcess
  private readonly pending = new Map<number, (message: Message) => void>()
  private nextId = 1
  readonly updates: Update[] = []
  readonly oracle = new ProtocolOracle()
  readonly permissionRequests: PermissionRequest[] = []
  private readonly waiters = new Set<(update: Update) => void>()
  permissionResponder: (
    request: PermissionRequest
  ) => { outcome: "selected"; optionId: string } | { outcome: "cancelled" } = (request) => {
    const allow = request.options.find((option) => option.kind === "allow_once") ?? request.options[0]
    if (allow === undefined) return { outcome: "cancelled" }
    return { outcome: "selected", optionId: allow.optionId }
  }

  constructor() {
    this.child = spawn("bun", ["src/index.ts"], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env }
    })
    readline
      .createInterface({ input: this.child.stdout! })
      .on("line", (line) => this.handle(JSON.parse(line) as Message))
  }

  request(method: string, params: unknown): Promise<Message> {
    const id = this.nextId++
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    return new Promise((resolve) => this.pending.set(id, resolve))
  }

  async call<M extends keyof Responses>(method: M, params: unknown): Promise<Responses[M]> {
    const message = await this.request(method, params)
    if (message.error) throw new Error(`${method} failed: ${JSON.stringify(message.error)}`)
    return message.result as Responses[M]
  }

  notify(method: string, params: unknown): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  mark(): number {
    return this.updates.length
  }

  since(mark: number, sessionId?: string): Update[] {
    return this.updates.slice(mark).filter((update) => sessionId === undefined || update.sessionId === sessionId)
  }

  nextUpdate(predicate: (update: Update) => boolean, timeoutMs = TURN_TIMEOUT_MS, from = this.mark()): Promise<Update> {
    const existing = this.since(from).find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error("timed out waiting for session update"))
      }, timeoutMs)
      const waiter = (update: Update) => {
        if (!predicate(update)) return
        clearTimeout(timer)
        this.waiters.delete(waiter)
        resolve(update)
      }
      this.waiters.add(waiter)
    })
  }

  idle(sessionId: string, timeoutMs = TURN_TIMEOUT_MS, from = this.mark()): Promise<Update> {
    return this.nextUpdate(
      (update) => update.sessionId === sessionId && update.sessionUpdate === "state_update" && update.state === "idle",
      timeoutMs,
      from
    )
  }

  text(mark: number, sessionId: string): string {
    const reducer = new ProtocolOracle()
    for (const update of this.since(mark, sessionId)) {
      if (!update._meta?.codex?.notice) reducer.accept(sessionId, asSessionUpdate(update))
    }
    return [...reducer.messages.values()].join("")
  }

  close(): void {
    this.child.stdin!.end()
    setTimeout(() => this.child.kill(), 2_000).unref()
  }

  private handle(message: Message): void {
    if (message.id !== undefined && message.method === undefined) {
      this.pending.get(message.id)?.(message)
      this.pending.delete(message.id)
      return
    }
    if (message.method === "session/update") {
      const params = message.params as { sessionId: string; update: Omit<Update, "sessionId"> }
      const update: Update = { sessionId: params.sessionId, ...params.update }
      this.oracle.accept(update.sessionId, asSessionUpdate(update))
      this.updates.push(update)
      for (const waiter of [...this.waiters]) waiter(update)
      return
    }
    if (message.method === "session/request_permission" && message.id !== undefined) {
      const request = message.params as PermissionRequest
      this.permissionRequests.push(request)
      this.child.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: this.permissionResponder(request) } })}\n`
      )
      return
    }
    if (message.id !== undefined) {
      this.child.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported" } })}\n`
      )
    }
  }
}

describe.skipIf(!RUN)("live codex", () => {
  let client: StdioClient
  let cwd: string
  let firstSessionId: string

  beforeAll(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-v2-e2e-"))
    client = new StdioClient()
    const init = await client.call("initialize", {
      protocolVersion: 2,
      info: { name: "e2e", version: "0" },
      capabilities: { elicitation: { url: {}, form: {} } }
    })
    expect(init.protocolVersion).toBe(2)
    expect(init.capabilities.providers).toEqual({})
    expect(init.capabilities._meta).toMatchObject({
      alwith: { turns: { version: 2 } },
      codex: { forkAtTurn: true, sessionLineage: true }
    })
    if (process.env["CODEX_API_KEY"] || process.env["OPENAI_API_KEY"]) {
      await client.call("auth/login", { methodId: "api-key" })
    }
  })

  afterEach(() => {
    expect(client.oracle.issues).toEqual([])
  })

  afterAll(() => {
    client?.close()
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it.each(["manual", "automatic"] as const)(
    "continues a native capacity failure without duplicating its prompt (%s)",
    async (trigger) => {
      let overloaded = true
      const gateway = await startFakeGateway({
        token: "capacity-token",
        reply: "CAPACITY_RECOVERED",
        overloaded: () => overloaded
      })
      let sessionId: string | undefined
      try {
        await client.call("providers/set", {
          providerId: "openai",
          apiType: "openai",
          baseUrl: gateway.baseUrl,
          headers: { authorization: "Bearer capacity-token" },
          _meta: { alwith: { model: "fake-model", models: [{ id: "fake-model", label: "Fake" }] } }
        })
        sessionId = (await client.call("session/new", { cwd, mcpServers: [] })).sessionId
        const mark = client.mark()
        await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "CAPACITY_PROMPT" }] })
        expect((await client.idle(sessionId, TURN_TIMEOUT_MS, mark)).stopReason).toBe("error")
        const page = await client.call("_codex/session_history", {
          sessionId,
          itemsView: "full",
          sortDirection: "desc",
          limit: 1
        })
        const failed = page.turns[0]!
        expect(failed.error?.codexErrorInfo).toBe("serverOverloaded")
        expect(failed.updates.at(-1)).toMatchObject({
          sessionUpdate: "agent_message",
          messageId: `codex-error:${failed.turnId}`,
          _meta: { codex: { error: { category: "overloaded", retryable: true } } }
        })
        overloaded = false
        const retryMark = client.mark()
        await client.call("_codex/session_retry", { sessionId, turnId: failed.turnId, trigger })
        expect((await client.idle(sessionId, TURN_TIMEOUT_MS, retryMark)).stopReason).toBe("end_turn")
        expect(client.text(retryMark, sessionId)).toContain("CAPACITY_RECOVERED")
        expect(client.since(retryMark, sessionId).filter((update) => update.sessionUpdate === "user_message")).toEqual(
          []
        )
        const restored = await client.call("_codex/session_history", {
          sessionId,
          itemsView: "full"
        })
        expect(restored.turns.filter((entry) => entry.status === "failed")).toHaveLength(1)
        expect(
          restored.turns.flatMap((entry) => entry.updates).filter((update) => update.sessionUpdate === "user_message")
        ).toHaveLength(1)
      } finally {
        if (sessionId) await client.call("session/close", { sessionId })
        await client.call("providers/disable", { providerId: "openai" })
        await gateway.close()
      }
    }
  )

  it("runs a prompt through running, chunks, usage, and idle", async () => {
    const created = await client.call("session/new", { cwd, mcpServers: [] })
    firstSessionId = created.sessionId
    expect(created.configOptions.map((option) => option.configId)).toEqual(
      expect.arrayContaining(["mode", "model", "effort"]) as string[]
    )
    const mark = client.mark()
    const receipt = await client.call("session/prompt", {
      sessionId: firstSessionId,
      prompt: [{ type: "text", text: "Reply with exactly the single word: pong" }]
    })
    expect(receipt).toEqual({ messageId: expect.any(String) as string })
    const idle = await client.idle(firstSessionId, TURN_TIMEOUT_MS, mark)
    expect(idle.stopReason).toBe("end_turn")
    expect(idle.usage?.totalTokens).toBeGreaterThan(0)
    const frames = client.since(mark, firstSessionId)
    expect(frames[0]).toMatchObject({ sessionUpdate: "state_update", state: "running" })
    const userMessages = frames.filter((update) => update.sessionUpdate === "user_message")
    expect(userMessages[0]).toMatchObject({
      messageId: receipt.messageId,
      content: [{ type: "text", text: "Reply with exactly the single word: pong" }]
    })
    expect(
      userMessages.some(
        (update) => update.messageId === receipt.messageId && typeof update._meta?.codex?.turnId === "string"
      )
    ).toBe(true)
    expect(new Set(userMessages.map((update) => update.messageId))).toEqual(new Set([receipt.messageId]))
    expect(client.text(mark, firstSessionId).toLowerCase()).toContain("pong")
    expect(
      frames.find((update) => update.sessionUpdate === "session_info_update" && update.title !== undefined)?.title
    ).toBe("Reply with exactly the single word: pong")
  })

  it("restores file cards and the prompt title through a fresh adapter process", async () => {
    const name = "中文 space #1 (copy).txt"
    const file = path.join(cwd, name)
    fs.writeFileSync(file, "FILE_REFERENCE_TEST\n")
    const reference = { type: "resource_link", name, uri: pathToFileURL(file).href }
    const text = "QA-HISTORY-FILES: Reply with exactly FILE_REFERENCE_OK. Do not use tools."
    const { sessionId } = await client.call("session/new", { cwd, mcpServers: [] })
    const mark = client.mark()
    await client.call("session/prompt", { sessionId, prompt: [reference, { type: "text", text }] })
    expect((await client.idle(sessionId, TURN_TIMEOUT_MS, mark)).stopReason).toBe("end_turn")
    await client.call("session/close", { sessionId })
    const fresh = new StdioClient()
    try {
      await fresh.call("initialize", { protocolVersion: 2, info: { name: "file-replay", version: "0" } })
      const listed = await fresh.call("session/list", { cwd })
      expect(listed.sessions.find((row) => row.sessionId === sessionId)?.title).toBe(text)
      const replayMark = fresh.mark()
      await fresh.call("session/resume", { sessionId, cwd, replayFrom: { type: "start" }, mcpServers: [] })
      const frames = fresh.since(replayMark, sessionId)
      expect(
        frames.find((update) => update.sessionUpdate === "session_info_update" && update.title !== undefined)?.title
      ).toBe(text)
      expect(frames.find((update) => update.sessionUpdate === "user_message")?.content).toEqual([
        reference,
        { type: "text", text }
      ])
      await fresh.call("session/close", { sessionId })
    } finally {
      fresh.close()
    }
  })

  it("applies config options and answers /status locally", async () => {
    const response = await client.call("session/set_config_option", {
      sessionId: firstSessionId,
      configId: "effort",
      type: "id",
      value: "low"
    })
    expect(response.configOptions.find((option) => option.configId === "effort")?.currentValue).toBe("low")
    const mark = client.mark()
    await client.call("session/prompt", { sessionId: firstSessionId, prompt: [{ type: "text", text: "/status" }] })
    await client.idle(firstSessionId, 10_000, mark)
    expect(client.text(mark, firstSessionId)).toContain("(low)")
  })

  it("does not replay a transformed /plan prompt over its original command receipt", async () => {
    const created = await client.call("session/new", { cwd, mcpServers: [] })
    const sessionId = created.sessionId
    const command = "/plan Give a short plan for saying hello. Do not edit files."
    const mark = client.mark()
    const receipt = await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: command }] })
    await client.idle(sessionId, TURN_TIMEOUT_MS, mark)
    const liveMessages = client.since(mark, sessionId).filter((update) => update.sessionUpdate === "user_message")
    expect(liveMessages.length).toBeGreaterThan(0)
    expect(
      liveMessages.every((update) => update.messageId === receipt.messageId && update.content?.[0]?.text === command)
    ).toBe(true)

    await client.call("session/close", { sessionId })
    const fresh = new StdioClient()
    try {
      await fresh.call("initialize", { protocolVersion: 2, info: { name: "command-replay", version: "0" } })
      const replayMark = fresh.mark()
      await fresh.call("session/resume", { sessionId, cwd, replayFrom: { type: "start" }, mcpServers: [] })
      const replayed = fresh.since(replayMark, sessionId).filter((update) => update.sessionUpdate === "user_message")
      expect(replayed).toMatchObject([{ messageId: receipt.messageId, content: [{ type: "text", text: command }] }])
      const forkMark = fresh.mark()
      const forked = await fresh.call("session/fork", {
        sessionId,
        cwd,
        mcpServers: [],
        _meta: { codex: { lastTurnId: replayed[0]?._meta?.codex?.turnId } }
      })
      expect(
        fresh.since(forkMark, forked.sessionId).filter((update) => update.sessionUpdate === "user_message")
      ).toMatchObject([{ messageId: receipt.messageId, content: [{ type: "text", text: command }] }])
      await fresh.call("session/close", { sessionId: forked.sessionId })
      await fresh.call("session/close", { sessionId })
    } finally {
      fresh.close()
    }
  })

  it("does not create a second user message for /review on resume", async () => {
    // Review a bounded fixture, not the developer's potentially large working diff.
    const reviewCwd = path.join(cwd, "review")
    execFileSync("git", ["init", "--quiet", reviewCwd])
    fs.writeFileSync(
      path.join(reviewCwd, "add.ts"),
      "export function add(a: number, b: number): number { return a + b; }\n"
    )
    const created = await client.call("session/new", { cwd: reviewCwd, mcpServers: [] })
    const sessionId = created.sessionId
    const mark = client.mark()
    const receipt = await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "/review" }] })
    await client.idle(sessionId, TURN_TIMEOUT_MS, mark)
    const liveMessages = client.since(mark, sessionId).filter((update) => update.sessionUpdate === "user_message")
    expect(liveMessages.length).toBeGreaterThan(0)
    expect(
      liveMessages.every((update) => update.messageId === receipt.messageId && update.content?.[0]?.text === "/review")
    ).toBe(true)

    await client.call("session/close", { sessionId })
    const fresh = new StdioClient()
    try {
      await fresh.call("initialize", { protocolVersion: 2, info: { name: "review-replay", version: "0" } })
      const replayMark = fresh.mark()
      await fresh.call("session/resume", { sessionId, cwd: reviewCwd, replayFrom: { type: "start" }, mcpServers: [] })
      expect(
        fresh.since(replayMark, sessionId).filter((update) => update.sessionUpdate === "user_message")
      ).toMatchObject([{ messageId: receipt.messageId, content: [{ type: "text", text: "/review" }] }])
      await fresh.call("session/close", { sessionId })
    } finally {
      fresh.close()
    }
  })

  it("cancels a running turn with stopReason cancelled", async () => {
    const created = await client.call("session/new", { cwd, mcpServers: [] })
    const sessionId = created.sessionId
    const mark = client.mark()
    await client.call("session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "Write a 2000-word essay about the history of computing, one paragraph per decade." }
      ]
    })
    await client
      .nextUpdate(
        (update) => update.sessionId === sessionId && update.sessionUpdate === "agent_message_chunk",
        60_000,
        mark
      )
      .catch(() => undefined)
    client.notify("session/cancel", { sessionId })
    const idle = await client.idle(sessionId, 30_000, mark)
    expect(idle.stopReason).toBe("cancelled")
    await client.call("session/close", { sessionId })
  })

  it("routes command approvals through session/request_permission with requires_action", async () => {
    const created = await client.call("session/new", { cwd, mcpServers: [] })
    const sessionId = created.sessionId
    await client.call("session/set_config_option", { sessionId, configId: "mode", type: "id", value: "read-only" })
    const mark = client.mark()
    const requestsBefore = client.permissionRequests.length
    await client.call("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "Run this exact shell command and show me its output: curl -sS https://example.com | head -c 60"
        }
      ]
    })
    const idle = await client.idle(sessionId, TURN_TIMEOUT_MS, mark)
    expect(idle.stopReason).toBe("end_turn")
    const requests = client.permissionRequests.slice(requestsBefore)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests[0]).toMatchObject({
      sessionId,
      title: expect.any(String) as unknown,
      subject: { type: "tool_call", toolCall: { toolCallId: expect.any(String) as unknown } }
    })
    expect(requests[0]?.options.some((option) => option.kind === "allow_once")).toBe(true)
    const states = client
      .since(mark, sessionId)
      .filter((update) => update.sessionUpdate === "state_update")
      .map((update) => update.state)
    expect(states).toContain("requires_action")
    expect(states.at(-1)).toBe("idle")
    expect(client.since(mark, sessionId).some((update) => update.sessionUpdate === "terminal_update")).toBe(true)
    await client.call("session/close", { sessionId })
  })

  it("replays history on resume, forks, and deletes", async () => {
    await client.call("session/close", { sessionId: firstSessionId })
    const mark = client.mark()
    const resumed = await client.call("session/resume", {
      sessionId: firstSessionId,
      cwd,
      replayFrom: { type: "start" },
      mcpServers: []
    })
    expect(resumed.configOptions.length).toBeGreaterThan(0)
    const replay = client.since(mark, firstSessionId)
    expect(
      replay.some(
        (update) =>
          update.sessionUpdate === "user_message" &&
          update.content?.[0]?.text === "Reply with exactly the single word: pong"
      )
    ).toBe(true)
    expect(replay.some((update) => update.sessionUpdate === "agent_message")).toBe(true)
    expect(replay.find((update) => update.sessionUpdate === "session_info_update")?.title).toBeTruthy()

    const forkMark = client.mark()
    const boundary = replay.find((update) => update.sessionUpdate === "agent_message")?._meta?.codex?.turnId
    expect(boundary).toEqual(expect.any(String) as string)
    const nextMark = client.mark()
    await client.call("session/prompt", {
      sessionId: firstSessionId,
      prompt: [{ type: "text", text: "Reply with exactly: AFTER_FORK_BOUNDARY" }]
    })
    expect((await client.idle(firstSessionId, TURN_TIMEOUT_MS, nextMark)).stopReason).toBe("end_turn")
    const forked = await client.call("session/fork", {
      sessionId: firstSessionId,
      cwd,
      mcpServers: [],
      _meta: { codex: { lastTurnId: boundary } }
    })
    expect(forked.sessionId).not.toBe(firstSessionId)
    const forkHistory = client.since(forkMark, forked.sessionId)
    expect(forkHistory.some((update) => update.sessionUpdate === "agent_message")).toBe(true)
    expect(JSON.stringify(forkHistory)).not.toContain("AFTER_FORK_BOUNDARY")
    expect(forked._meta.codex).toMatchObject({
      nativeSessionId: expect.any(String) as unknown,
      forkedFromId: firstSessionId,
      forkedAtTurnId: boundary
    })

    await client.call("session/close", { sessionId: forked.sessionId })
    const restoredFork = await client.call("session/resume", {
      sessionId: forked.sessionId,
      cwd,
      mcpServers: [],
      replayFrom: { type: "start" }
    })
    expect(restoredFork._meta.codex?.forkedAtTurnId).toBe(boundary)
    const continueMark = client.mark()
    await client.call("session/prompt", {
      sessionId: forked.sessionId,
      prompt: [{ type: "text", text: "Reply with exactly: FORK_CONTINUED" }]
    })
    expect((await client.idle(forked.sessionId, TURN_TIMEOUT_MS, continueMark)).stopReason).toBe("end_turn")
    expect(client.text(continueMark, forked.sessionId)).toContain("FORK_CONTINUED")

    await client.call("session/close", { sessionId: forked.sessionId })
    const fresh = new StdioClient()
    try {
      await fresh.call("initialize", { protocolVersion: 2, info: { name: "fork-list-e2e", version: "0" } })
      const listed = await fresh.call("session/list", {})
      expect(listed.sessions.find((entry) => entry.sessionId === forked.sessionId)?._meta.codex?.forkedFromId).toBe(
        firstSessionId
      )
    } finally {
      fresh.close()
    }
    await client.call("session/close", { sessionId: firstSessionId })
    expect(await client.call("session/delete", { sessionId: forked.sessionId })).toEqual({})
  })

  it("routes through a gateway and returns to native with foreign plaintext and encrypted reasoning", async () => {
    const gateway: FakeGateway = await startFakeGateway({
      token: "e2e-token",
      reply: "pong from the fake gateway",
      reasoning: true
    })
    try {
      const providerRequest = {
        providerId: "openai",
        apiType: "openai",
        baseUrl: gateway.baseUrl,
        headers: { authorization: "Bearer e2e-token" },
        _meta: { alwith: { model: "fake-model", models: [{ id: "fake-model", label: "Fake model" }] } }
      }
      const empty = await client.call("session/new", { cwd, mcpServers: [] })
      await expect(client.call("providers/set", providerRequest)).rejects.toThrow(
        "Cannot reload this session's history"
      )
      expect((await client.call("providers/list", {})).providers[0]?.current.baseUrl).toBe("https://api.openai.com/v1")
      await client.call("session/close", { sessionId: empty.sessionId })
      const existing = await client.call("session/new", {
        cwd,
        mcpServers: [],
        _meta: { codex: { seedHistory: [{ role: "user", text: "Earlier context for the gateway routing test." }] } }
      })
      await client.call("providers/set", providerRequest)
      const listed = await client.call("providers/list", {})
      expect(listed.providers[0]?.current.baseUrl).toBe(gateway.baseUrl)
      const created = await client.call("session/new", { cwd, mcpServers: [] })
      const sessionId = created.sessionId
      expect(created.configOptions.find((option) => option.configId === "model")?.currentValue).toBe("fake-model")
      const mark = client.mark()
      await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "ping" }] })
      const idle = await client.idle(sessionId, 60_000, mark)
      expect(idle.stopReason).toBe("end_turn")
      expect(client.text(mark, sessionId)).toBe("pong from the fake gateway")
      expect(gateway.requests.map((request) => [request.path, request.authorization, request.body["model"]])).toEqual([
        ["/v1/responses", "Bearer e2e-token", "fake-model"]
      ])
      const existingMark = client.mark()
      await client.call("session/prompt", {
        sessionId: existing.sessionId,
        prompt: [{ type: "text", text: "ping existing session" }]
      })
      expect((await client.idle(existing.sessionId, 60_000, existingMark)).stopReason).toBe("end_turn")
      expect(client.text(existingMark, existing.sessionId)).toBe("pong from the fake gateway")
      expect(gateway.requests).toHaveLength(2)
      await client.call("session/close", { sessionId })
      await client.call("providers/disable", { providerId: "openai" })
      const nativeMark = client.mark()
      await client.call("session/prompt", {
        sessionId: existing.sessionId,
        prompt: [{ type: "text", text: "Reply with exactly: native route restored" }]
      })
      const nativeIdle = await client.idle(existing.sessionId, TURN_TIMEOUT_MS, nativeMark)
      expect(nativeIdle.stopReason, client.text(nativeMark, existing.sessionId)).toBe("end_turn")
      expect(gateway.requests).toHaveLength(2)
      await client.call("session/close", { sessionId: existing.sessionId })
      expect((await client.call("providers/list", {})).providers[0]?.current.baseUrl).toBe("https://api.openai.com/v1")
    } finally {
      await gateway.close()
    }
  })
})

describe.skipIf(!RUN)("live read-only history", () => {
  it("pages a foreign writer's history, detects changes and reads closed and archived sessions", async () => {
    const owner = new StdioClient()
    const reader = new StdioClient()
    const gateway = await startFakeGateway({ token: "history-token", reply: "HISTORY_ANSWER", delayMs: 1500 })
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-history-e2e-"))
    let sessionId: string | undefined
    try {
      for (const connection of [owner, reader]) {
        const init = await connection.call("initialize", {
          protocolVersion: 2,
          info: { name: "history-e2e", version: "0" }
        })
        expect(init.capabilities._meta.codex.sessionHistory).toMatchObject({ version: 2, items: true })
      }
      await owner.call("providers/set", {
        providerId: "openai",
        apiType: "openai",
        baseUrl: gateway.baseUrl,
        headers: { authorization: "Bearer history-token" },
        _meta: { alwith: { model: "fake-model", models: [{ id: "fake-model", label: "Fake" }] } }
      })
      sessionId = (await owner.call("session/new", { cwd })).sessionId
      const prompt = async (text: string): Promise<void> => {
        const mark = owner.mark()
        await owner.call("session/prompt", { sessionId, prompt: [{ type: "text", text }] })
        expect((await owner.idle(sessionId!, 60_000, mark)).stopReason).toBe("end_turn")
      }
      await prompt("HISTORY_ONE")
      await prompt("HISTORY_TWO")
      const ownerMark = owner.mark()
      const first = await reader.call("_codex/session_history", {
        mode: "export",
        itemsView: "full",
        sessionId,
        limit: 1
      })
      expect(first.turns).toHaveLength(1)
      expect(first.complete).toBe(false)
      expect(first.nextCursor).toEqual(expect.any(String) as string)
      const second = await reader.call("_codex/session_history", {
        mode: "export",
        itemsView: "full",
        sessionId,
        limit: 1,
        cursor: first.nextCursor
      })
      expect(second).toMatchObject({ revision: first.revision, complete: true, nextCursor: null })
      expect(JSON.stringify(first.turns)).toContain("HISTORY_ONE")
      expect(JSON.stringify(second.turns)).toContain("HISTORY_TWO")
      expect(first.turns[0]?.turnId).not.toBe(second.turns[0]?.turnId)
      expect(first.turns[0]?.updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionUpdate: "agent_message",
            _meta: expect.objectContaining({
              codex: expect.objectContaining({ turnId: first.turns[0]?.turnId }) as unknown
            }) as unknown
          })
        ]) as acp.SessionUpdate[]
      )
      const latest = await reader.call("_codex/session_history", {
        sessionId,
        sortDirection: "desc",
        limit: 1
      })
      expect(latest).toMatchObject({ consistency: "live", revision: null })
      expect(latest.turns[0]).toMatchObject({ turnId: second.turns[0]?.turnId, itemsView: "summary", updates: [] })
      const items = await reader.call("_codex/session_history_items", {
        sessionId,
        turnId: first.turns[0]!.turnId,
        limit: 1,
        includeNative: true
      })
      expect(items.items).toHaveLength(1)
      expect(items.items[0]).toMatchObject({
        turnId: first.turns[0]!.turnId,
        itemId: expect.any(String) as unknown,
        _meta: { codex: { item: { type: "userMessage" } } }
      })
      expect(JSON.stringify(items.items)).toContain("HISTORY_ONE")
      const anchored = await reader.call("_codex/session_history_items", {
        sessionId,
        turnId: first.turns[0]!.turnId,
        anchorItemId: items.items[0]!.itemId,
        includeNative: true
      })
      expect(anchored.items.some((entry) => entry.itemId === items.items[0]!.itemId)).toBe(false)
      expect(JSON.stringify(anchored.items)).toContain("HISTORY_ANSWER")
      const nextItems = await reader.call("_codex/session_history_items", {
        sessionId,
        turnId: first.turns[0]!.turnId,
        cursor: items.nextCursor,
        includeNative: true
      })
      expect(JSON.stringify(nextItems.items)).toContain("HISTORY_ANSWER")
      expect(reader.updates).toEqual([])
      expect(owner.since(ownerMark)).toEqual([])
      expect((await reader.request("session/prompt", { sessionId, prompt: [] })).error).toBeDefined()
      const runningMark = owner.mark()
      const third = prompt("HISTORY_THREE")
      try {
        await owner.nextUpdate(
          (update) =>
            update.sessionId === sessionId && update.sessionUpdate === "state_update" && update.state === "running",
          60_000,
          runningMark
        )
        const browsing = await owner.call("_codex/session_history", { sessionId, limit: 1 })
        expect(browsing).toMatchObject({ running: true, consistency: "live" })
        expect(browsing.turns[0]?.turnId).toBe(first.turns[0]?.turnId)
        const exporting = await owner.request("_codex/session_history", { sessionId, mode: "export" })
        expect(exporting.error?.data.reason).toBe("history_busy")
      } finally {
        await third
      }
      expect(
        (
          await reader.request("_codex/session_history", {
            mode: "export",
            itemsView: "full",
            sessionId,
            cursor: first.nextCursor
          })
        ).error?.data.reason
      ).toBe("history_changed")
      await owner.call("session/close", { sessionId })
      const closed = await reader.call("_codex/session_history", {
        mode: "export",
        itemsView: "full",
        sessionId
      })
      expect(closed.complete).toBe(true)
      expect(JSON.stringify(closed.turns)).toContain("HISTORY_THREE")
      await owner.call("_codex/session_archive", { sessionId })
      const archived = await reader.call("_codex/session_history", {
        mode: "export",
        itemsView: "full",
        sessionId
      })
      expect(archived.turns).toEqual(closed.turns)
      const listed = await reader.call("session/list", { cwd: closed.cwd, _meta: { codex: { archived: true } } })
      expect(
        listed.sessions.some((entry: { sessionId: string }) => entry.sessionId === sessionId),
        JSON.stringify({ cwd, storedCwd: closed.cwd, listed })
      ).toBe(true)
      expect(reader.updates).toEqual([])
      expect(owner.oracle.issues).toEqual([])
    } finally {
      try {
        if (sessionId) await owner.call("session/delete", { sessionId })
      } finally {
        owner.close()
        reader.close()
        await gateway.close()
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    }
  })
})
