import type { ReasoningEffort } from "../app-server/ReasoningEffort"
import type { AppServerClient } from "../codex/AppServerClient"
import { logger } from "../util/logger"
import type { ClientSession } from "./clientSession"

const PROMPT = `Suggest the single most likely next message the user would send in this conversation, in the user's language and voice. Keep it short and directly useful. If the next step is unclear or the conversation is finished, use null. Do not answer the suggestion, perform work, or use tools. Return only JSON: {"suggestion": "short message"} or {"suggestion": null}.`

/** Ephemeral Codex threads are never installed as ACP sessions or forwarded to the UI. */
export class ComposerPredictions {
  private readonly jobs = new Map<string, AbortController>()
  constructor(private readonly codex: AppServerClient) {}

  cancel(sessionId: string): void {
    this.jobs.get(sessionId)?.abort()
    this.jobs.delete(sessionId)
  }

  start(
    sessionId: string,
    sourceTurnId: string,
    client: ClientSession,
    lifetime: AbortSignal,
    effort?: ReasoningEffort
  ): void {
    this.cancel(sessionId)
    const job = new AbortController()
    this.jobs.set(sessionId, job)
    void this.generate(sessionId, sourceTurnId, client, lifetime, job, effort).catch((error) =>
      logger.error("prediction failed", error)
    )
  }

  private async generate(
    sessionId: string,
    sourceTurnId: string,
    client: ClientSession,
    lifetime: AbortSignal,
    job: AbortController,
    effort?: ReasoningEffort
  ): Promise<void> {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 60_000)
    const signal = AbortSignal.any([job.signal, lifetime, this.codex.disconnectSignal, timeout.signal])
    let forkId: string | undefined
    let text: string | undefined
    const stop = this.codex.observeNotifications((notification) => {
      if (
        notification.method === "item/completed" &&
        notification.params.threadId === forkId &&
        notification.params.item.type === "agentMessage"
      ) {
        text = notification.params.item.text
      }
    })
    let result: { type: "completed"; text: string | null } | { type: "failed" } = { type: "failed" }
    try {
      signal.throwIfAborted()
      const fork = await this.codex.threadFork({
        threadId: sessionId,
        experimentalPredictionMode: true,
        ephemeral: true,
        excludeTurns: true,
        threadSource: "composer_predictions"
      })
      forkId = fork.thread.id
      signal.throwIfAborted()
      const completed = await this.codex.runTurn(
        {
          threadId: forkId,
          turnTrigger: "composer_predictions",
          responsesapiClientMetadata: {
            prediction_source_thread_id: sessionId,
            prediction_source_turn_id: sourceTurnId,
            prediction_trigger: "live"
          },
          input: [{ type: "text", text: PROMPT, text_elements: [] }],
          outputSchema: null,
          ...(effort === undefined ? {} : { effort })
        },
        undefined,
        signal
      )
      if (completed.turn.status !== "completed") throw new Error("Prediction turn did not complete")
      const parsed: unknown = JSON.parse(text ?? "")
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("suggestion" in parsed) ||
        (parsed.suggestion !== null && typeof parsed.suggestion !== "string")
      )
        throw new Error("Invalid prediction output")
      const suggestion = parsed.suggestion
      if (typeof suggestion === "string" && suggestion.length > 1000)
        throw new Error("Prediction exceeds the draft limit")
      result = { type: "completed", text: suggestion === null ? null : suggestion.trim() || null }
    } catch (error) {
      if (!signal.aborted) logger.error("generating composer prediction failed", error)
    } finally {
      clearTimeout(timer)
      stop()
      if (forkId) {
        // Unsubscribe also tears down any still-running ephemeral turn.
        await this.codex
          .threadUnsubscribe({ threadId: forkId })
          .catch((error) => logger.error("closing prediction thread failed", error))
      }
    }
    const current = this.jobs.get(sessionId) === job
    if (current) this.jobs.delete(sessionId)
    if (!job.signal.aborted && !lifetime.aborted && !this.codex.disconnectSignal.aborted && current) {
      await client.update({
        sessionUpdate: "session_info_update",
        _meta: { codex: { prediction: { sourceTurnId, result } } }
      })
    }
  }
}
