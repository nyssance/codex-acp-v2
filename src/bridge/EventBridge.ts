import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {ServerNotification} from "../app-server";
import type {
    ErrorNotification,
    RateLimitSnapshot,
    ThreadItem,
    TurnError,
    TurnPlanUpdatedNotification,
} from "../app-server/v2";
import type {ClientSession} from "../agent/clientSession";
import type {Session} from "../agent/session";
import {logger} from "../util/logger";
import {toTokenCount} from "../util/tokens";
import {terminalExited, terminalOutputChunk, terminalStarted, usesTerminal} from "./terminal";
import * as tool from "./toolCalls";
import {fromUserInput} from "../codex/sessionConfig";

export type CompletedPlan = {itemId: string; text: string};

export const TURN_PLAN_ID = "codex-turn-plan";
const PLAN_STREAM_INTERVAL_MS = 150;

/**
 * Translates Codex app-server notifications for one thread into ACP v2
 * `session/update` frames. One instance lives as long as the session; per-turn
 * bookkeeping is reset by `beginTurn`.
 */
export class EventBridge {
    readonly rateLimits = new Map<string, RateLimitSnapshot>();
    private lastError: TurnError | null = null;
    private completedPlan: CompletedPlan | null = null;
    private noticeSequence = 0;

    /** Tool calls reported as pending or in progress and not yet completed. */
    private readonly openToolCalls = new Set<string>();
    private readonly messagePhases = new Map<string, string | null>();
    private readonly reasoningWithDeltas = new Set<string>();
    private readonly terminalItems = new Set<string>();
    private readonly imageGenerations = new Set<string>();
    private readonly subAgentActivities = new Set<string>();
    private readonly fuzzySearches = new Set<string>();
    private readonly guardianReviews = new Set<string>();
    private readonly planText = new Map<string, string>();
    private readonly planEmitted = new Map<string, string>();
    private readonly pendingPlans = new Set<string>();
    private planTimer: ReturnType<typeof setTimeout> | null = null;
    private planChain: Promise<void> = Promise.resolve();

    constructor(private readonly client: ClientSession, private readonly session: Session) {}

    beginTurn(): void {
        this.lastError = null;
        this.completedPlan = null;
        this.openToolCalls.clear();
        this.clearPlanState();
    }

    takeError(): TurnError | null {
        const error = this.lastError;
        this.lastError = null;
        return error;
    }

    takeCompletedPlan(): CompletedPlan | null {
        const plan = this.completedPlan;
        this.completedPlan = null;
        return plan;
    }

    async handle(notification: ServerNotification): Promise<void> {
        const updates = await this.translate(notification);
        for (const update of updates) {
            this.trackToolCall(update);
            await this.client.update(update);
        }
    }

    /**
     * Cancelled turns leave Codex items without a completion; the protocol expects
     * every unfinished tool call to end as `cancelled` before the idle frame.
     */
    async cancelOpenToolCalls(): Promise<void> {
        const ids = [...this.openToolCalls];
        this.openToolCalls.clear();
        for (const toolCallId of ids) {
            await this.client.update(tool.toolCallCancelled(toolCallId));
        }
    }

    private trackToolCall(update: acp.SessionUpdate): void {
        if (update.sessionUpdate !== "tool_call_update") return;
        const {toolCallId, status} = update as acp.ToolCallUpdate;
        if (status === "pending" || status === "in_progress") this.openToolCalls.add(toolCallId);
        else if (status !== undefined && status !== null) this.openToolCalls.delete(toolCallId);
    }

    async flush(): Promise<void> {
        await this.flushPlans();
    }

    dispose(): void {
        this.clearPlanState();
    }

    private async translate(notification: ServerNotification): Promise<acp.SessionUpdate[]> {
        switch (notification.method) {
            case "item/agentMessage/delta": {
                const {itemId, delta} = notification.params;
                return [this.agentMessage(itemId, delta)];
            }
            case "item/reasoning/summaryTextDelta":
            case "item/reasoning/textDelta":
                this.reasoningWithDeltas.add(notification.params.itemId);
                return [thought(notification.params.itemId, notification.params.delta)];
            case "item/reasoning/summaryPartAdded":
                this.reasoningWithDeltas.add(notification.params.itemId);
                return [thought(notification.params.itemId, "\n\n")];
            case "item/started":
                return this.itemStarted(notification.params.item);
            case "item/completed":
                return this.itemCompleted(notification.params.item);
            case "item/commandExecution/outputDelta": {
                const {itemId, delta} = notification.params;
                return this.terminalItems.has(itemId) && delta.length > 0 ? [terminalOutputChunk(itemId, delta)] : [];
            }
            case "item/commandExecution/terminalInteraction": {
                const {itemId, stdin} = notification.params;
                return this.terminalItems.has(itemId) ? [terminalOutputChunk(itemId, `\n${stdin}\n`)] : [];
            }
            case "item/fileChange/patchUpdated":
                return [tool.fileChangePatched({
                    type: "fileChange",
                    id: notification.params.itemId,
                    changes: notification.params.changes,
                    status: "inProgress",
                })];
            case "item/mcpToolCall/progress":
                return [tool.mcpToolCallProgress(notification.params.itemId, notification.params.message)];
            case "item/plan/delta":
                this.planDelta(notification.params.itemId, notification.params.delta);
                return [];
            case "turn/plan/updated":
                return [turnPlan(notification.params)];
            case "item/autoApprovalReview/started":
            case "item/autoApprovalReview/completed": {
                const reviewId = notification.params.reviewId;
                const create = !this.guardianReviews.has(reviewId);
                if (notification.method === "item/autoApprovalReview/started") this.guardianReviews.add(reviewId);
                else this.guardianReviews.delete(reviewId);
                return [tool.guardianReview(notification.params, create)];
            }
            case "fuzzyFileSearch/sessionUpdated": {
                const id = notification.params.sessionId;
                const create = !this.fuzzySearches.has(id);
                this.fuzzySearches.add(id);
                return [tool.fuzzySearchUpdated(notification.params, create)];
            }
            case "fuzzyFileSearch/sessionCompleted":
                this.fuzzySearches.delete(notification.params.sessionId);
                return [tool.fuzzySearchCompleted(notification.params)];
            case "thread/tokenUsage/updated": {
                const usage = notification.params.tokenUsage;
                this.session.lastUsage = toTokenCount(usage.last);
                this.session.contextWindow = usage.modelContextWindow;
                if (usage.modelContextWindow === null || usage.modelContextWindow <= 0) return [];
                return [{sessionUpdate: "usage_update", used: usage.last.totalTokens, size: usage.modelContextWindow}];
            }
            case "thread/name/updated": {
                const title = notification.params.threadName?.trim() || null;
                this.session.title = title;
                this.session.titleIsExplicit = title !== null;
                return [{sessionUpdate: "session_info_update", title}];
            }
            case "account/rateLimits/updated": {
                const snapshot = notification.params.rateLimits;
                this.rateLimits.set(snapshot.limitId ?? snapshot.limitName ?? "default", snapshot);
                return [];
            }
            case "error":
                return this.error(notification.params);
            case "warning":
                return [this.notice(`Warning: ${notification.params.message}`)];
            case "configWarning":
            case "deprecationNotice": {
                const {summary, details} = notification.params;
                return [this.notice(details ? `${summary}\n\n${details}` : summary)];
            }
            case "model/rerouted": {
                const {fromModel, toModel, reason} = notification.params;
                return [this.notice(`Model rerouted from ${fromModel} to ${toModel} (${reason}).`)];
            }
            case "turn/started":
            case "turn/completed":
                // Turn lifecycle is owned by the prompt flow, which emits the state updates.
                return [];
            case "thread/compacted":
            case "item/fileChange/outputDelta":
            case "command/exec/outputDelta":
                // Deprecated surfaces superseded by contextCompaction items and item/* deltas.
                return [];
            case "thread/started":
            case "thread/status/changed":
            case "thread/archived":
            case "thread/unarchived":
            case "thread/closed":
            case "thread/deleted":
            case "thread/reverted":
            case "thread/queue/changed":
            case "thread/settings/updated":
            case "thread/goal/updated":
            case "thread/goal/cleared":
            case "thread/project/updated":
            case "thread/environment/connected":
            case "thread/environment/disconnected":
            case "project/changed":
            case "skills/changed":
            case "hook/started":
            case "hook/completed":
            case "turn/diff/updated":
            case "turn/moderationMetadata":
            case "autoApprovalReview/strictReviewRequired":
            case "rawResponseItem/completed":
            case "rawResponse/completed":
            case "process/outputDelta":
            case "process/exited":
            case "serverRequest/resolved":
            case "mcpServer/oauthLogin/completed":
            case "mcpServer/startupStatus/updated":
            case "mcpServer/event/stream/notification":
            case "account/updated":
            case "account/login/completed":
            case "app/list/updated":
            case "remoteControl/status/changed":
            case "externalAgentConfig/import/progress":
            case "externalAgentConfig/import/completed":
            case "fs/changed":
            case "model/verification":
            case "modelProvider/authRecoveryStarted":
            case "modelProvider/authRecoveryCompleted":
            case "model/safetyBuffering/updated":
            case "guardianWarning":
            case "thread/realtime/started":
            case "thread/realtime/itemAdded":
            case "thread/realtime/item/started":
            case "thread/realtime/item/transcript/delta":
            case "thread/realtime/item/completed":
            case "thread/realtime/transcript/delta":
            case "thread/realtime/transcript/done":
            case "thread/realtime/outputAudio/delta":
            case "thread/realtime/sdp":
            case "thread/realtime/error":
            case "thread/realtime/closed":
            case "windows/worldWritableWarning":
            case "windowsSandbox/setupCompleted":
                return [];
        }
    }

    // ---- items --------------------------------------------------------------

    private itemStarted(item: ThreadItem): acp.SessionUpdate[] {
        switch (item.type) {
            case "agentMessage":
                this.messagePhases.set(item.id, item.phase);
                return [];
            case "fileChange":
                return [tool.fileChangeStarted(item)];
            case "commandExecution":
                if (usesTerminal(item)) {
                    this.terminalItems.add(item.id);
                    return [tool.commandStarted(item), terminalStarted(item)];
                }
                return [tool.commandStarted(item)];
            case "mcpToolCall":
                return [tool.mcpToolCallStarted(item)];
            case "dynamicToolCall":
                return [tool.dynamicToolCallStarted(item)];
            case "webSearch":
                return [tool.webSearchStarted(item)];
            case "imageView":
                return [tool.imageViewed(item)];
            case "imageGeneration":
                this.imageGenerations.add(item.id);
                return [tool.imageGenerationStarted(item)];
            case "collabAgentToolCall":
                return [tool.collabToolCall(item, true)];
            case "subAgentActivity":
                this.subAgentActivities.add(item.id);
                return [tool.subAgentActivity(item, "in_progress", true)];
            case "contextCompaction":
                return [tool.compactionUpdate(item.id, "in_progress")];
            case "userMessage": {
                // ACP: the agent MUST report where the user message landed in session
                // history. Codex materializes it as a userMessage item at turn start;
                // its item id is the messageId a later replay reports under.
                const content = item.content.flatMap(fromUserInput);
                return content.length > 0 ? [{sessionUpdate: "user_message", messageId: item.id, content}] : [];
            }
            case "hookPrompt":
            case "functionCallOutput":
            case "plan":
            case "reasoning":
            case "sleep":
            case "enteredReviewMode":
            case "exitedReviewMode":
                return [];
        }
    }

    private async itemCompleted(item: ThreadItem): Promise<acp.SessionUpdate[]> {
        switch (item.type) {
            case "agentMessage":
                this.messagePhases.delete(item.id);
                return [];
            case "reasoning": {
                if (this.reasoningWithDeltas.delete(item.id)) return [];
                const parts = item.summary.length > 0 ? item.summary : item.content;
                const text = parts.filter(part => part.length > 0).join("\n\n");
                return text.length > 0 ? [thought(item.id, text)] : [];
            }
            case "fileChange":
                return [tool.fileChangeCompleted(item)];
            case "commandExecution": {
                const updates: acp.SessionUpdate[] = [];
                if (this.terminalItems.delete(item.id)) updates.push(terminalExited(item));
                updates.push(tool.commandCompleted(item));
                return updates;
            }
            case "mcpToolCall":
                return [tool.mcpToolCallCompleted(item)];
            case "dynamicToolCall":
                return [tool.dynamicToolCallCompleted(item)];
            case "webSearch":
                return [tool.webSearchCompleted(item)];
            case "imageView":
                return [];
            case "imageGeneration":
                return [this.imageGenerations.delete(item.id) ? tool.imageGenerationCompleted(item) : tool.imageGenerationSnapshot(item)];
            case "collabAgentToolCall":
                return [tool.collabToolCall(item, false)];
            case "subAgentActivity":
                return [tool.subAgentActivity(item, "completed", !this.subAgentActivities.delete(item.id))];
            case "contextCompaction":
                return [tool.compactionUpdate(item.id, "completed")];
            case "plan":
                return await this.planCompleted(item);
            case "exitedReviewMode": {
                const text = item.review.trim();
                return text.length > 0 ? [this.agentMessage(item.id, text)] : [];
            }
            case "userMessage":
            case "hookPrompt":
            case "functionCallOutput":
            case "sleep":
            case "enteredReviewMode":
                return [];
        }
    }

    private agentMessage(itemId: string, text: string): acp.SessionUpdate {
        const phase = this.messagePhases.get(itemId);
        return {
            sessionUpdate: "agent_message_chunk",
            messageId: itemId,
            content: {type: "text", text},
            ...(phase ? {_meta: {codex: {phase}}} : {}),
        };
    }

    private notice(text: string): acp.SessionUpdate {
        this.noticeSequence += 1;
        return {
            sessionUpdate: "agent_message_chunk",
            messageId: `codex-notice:${this.session.id}:${this.noticeSequence}`,
            content: {type: "text", text: `${text}\n\n`},
            _meta: {codex: {notice: true}},
        };
    }

    // ---- errors -------------------------------------------------------------

    private error(params: ErrorNotification): acp.SessionUpdate[] {
        if (params.willRetry) {
            logger.log("codex retrying after error", {sessionId: this.session.id, message: params.error.message});
            return [{sessionUpdate: "session_info_update", _meta: {codex: {retry: {message: params.error.message, turnId: params.turnId}}}}];
        }
        this.lastError = params.error;
        return [];
    }

    // ---- plans ----------------------------------------------------------------

    private planDelta(itemId: string, delta: string): void {
        if (delta.length === 0) return;
        this.planText.set(itemId, (this.planText.get(itemId) ?? "") + delta);
        this.pendingPlans.add(itemId);
        if (this.planTimer !== null) return;
        this.planTimer = setTimeout(() => {
            this.planTimer = null;
            void this.flushPlans().catch(error => logger.error("Failed to flush plan updates", error));
        }, PLAN_STREAM_INTERVAL_MS);
    }

    private async planCompleted(item: ThreadItem & {type: "plan"}): Promise<acp.SessionUpdate[]> {
        const text = item.text.length > 0 ? item.text : (this.planText.get(item.id) ?? "");
        this.pendingPlans.delete(item.id);
        this.planText.delete(item.id);
        if (text.length === 0) return [];
        this.completedPlan = {itemId: item.id, text};
        await this.emitPlan(item.id, text);
        return [];
    }

    private async flushPlans(): Promise<void> {
        if (this.planTimer !== null) {
            clearTimeout(this.planTimer);
            this.planTimer = null;
        }
        while (this.pendingPlans.size > 0) {
            const itemIds = [...this.pendingPlans];
            this.pendingPlans.clear();
            for (const itemId of itemIds) {
                const text = this.planText.get(itemId);
                if (text) await this.emitPlan(itemId, text);
            }
        }
    }

    private emitPlan(planId: string, text: string): Promise<void> {
        const send = async () => {
            if (this.planEmitted.get(planId) === text) return;
            this.planEmitted.set(planId, text);
            await this.client.update({sessionUpdate: "plan_update", plan: {type: "markdown", planId, content: text}});
        };
        const result = this.planChain.then(send);
        this.planChain = result.catch(() => {});
        return result;
    }

    private clearPlanState(): void {
        if (this.planTimer !== null) {
            clearTimeout(this.planTimer);
            this.planTimer = null;
        }
        this.pendingPlans.clear();
        this.planText.clear();
        this.planEmitted.clear();
    }
}

function thought(itemId: string, text: string): acp.SessionUpdate {
    return {sessionUpdate: "agent_thought_chunk", messageId: itemId, content: {type: "text", text}};
}

function turnPlan(params: TurnPlanUpdatedNotification): acp.SessionUpdate {
    return {
        sessionUpdate: "plan_update",
        plan: {
            type: "items",
            planId: TURN_PLAN_ID,
            entries: params.plan.map(step => ({
                content: step.step,
                priority: "medium",
                status: step.status === "inProgress" ? "in_progress" : step.status,
            })),
            ...(params.explanation ? {_meta: {codex: {explanation: params.explanation}}} : {}),
        },
    };
}
