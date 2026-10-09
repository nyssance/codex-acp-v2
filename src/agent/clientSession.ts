import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {StopReason} from "./turnErrors";
import {logger} from "../util/logger";
import {abortable} from "../util/abort";

/** The subset of `AgentContext` the agent uses, so tests can substitute a recorder. */
export type ClientLink = Pick<acp.AgentContext, "notify" | "request">;

export interface ClientCapabilitySet {
    readonly formElicitation: boolean;
    readonly urlElicitation: boolean;
}

/**
 * Outbound channel for one session. Every client-blocking request goes through
 * `waitingOnClient`, which reports `requires_action` while the first request is
 * open and `running` again once the last one resolves.
 */
export class ClientSession {
    private waiting = 0;
    private turnActive = false;
    private turnGeneration = 0;
    private disposed = false;
    private readonly output = new AbortController();
    private terminalAttempted = false;
    /** Receipt id of the prompt that owns the current turn; foreign turns have none. */
    private messageId: string | undefined;
    get signal(): AbortSignal { return this.output.signal; }

    constructor(
        readonly sessionId: string,
        private readonly link: ClientLink,
        readonly capabilities: ClientCapabilitySet,
    ) {}

    async update(update: acp.SessionUpdate): Promise<void> {
        if (this.disposed) return;
        await abortable(this.link.notify(acp.methods.client.session.update, {sessionId: this.sessionId, update}), this.output.signal);
    }

    async updateAll(updates: readonly acp.SessionUpdate[]): Promise<void> {
        for (const update of updates) await this.update(update);
    }

    async requestPermission(
        request: Omit<acp.RequestPermissionRequest, "sessionId">,
        signal?: AbortSignal,
    ): Promise<acp.RequestPermissionResponse> {
        signal = signal ? AbortSignal.any([signal, this.output.signal]) : this.output.signal;
        signal.throwIfAborted();
        return await this.waitingOnClient(() => {
            signal?.throwIfAborted();
            const pending = this.link.request(
                acp.methods.client.session.requestPermission,
                {sessionId: this.sessionId, ...request},
                signal ? {cancellationSignal: signal} : undefined,
            );
            return signal ? abortable(pending, signal) : pending;
        }, signal);
    }

    /** Machine work remains running; only permission/elicitation uses waitingOnClient. */
    async requestTool(params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
        return await this.link.request("_alwith/tool/call", params, {cancellationSignal: signal});
    }

    async createElicitation(request: acp.CreateElicitationRequest, signal?: AbortSignal): Promise<acp.CreateElicitationResponse> {
        signal = signal ? AbortSignal.any([signal, this.output.signal]) : this.output.signal;
        signal.throwIfAborted();
        return await this.waitingOnClient(() => {
            signal?.throwIfAborted();
            const pending = this.link.request(
                acp.methods.client.elicitation.create,
                request,
                signal ? {cancellationSignal: signal} : undefined,
            );
            return signal ? abortable(pending, signal) : pending;
        }, signal);
    }

    async completeElicitation(elicitationId: string): Promise<void> {
        if (this.disposed) return;
        await abortable(this.link.notify(acp.methods.client.elicitation.complete, {elicitationId}), this.output.signal);
    }

    /** Foreground work started: report `running` (fire-and-forget, the frame is already queued). */
    reportRunning(messageId?: string): void {
        this.messageId = messageId;
        this.terminalAttempted = false;
        this.turnGeneration += 1;
        this.turnActive = true;
        this.waiting = 0;
        void this.state({sessionUpdate: "state_update", state: "running"});
    }

    async reportIdle(stopReason: StopReason, extra?: {usage?: acp.Usage | null; error?: acp.Error; _meta?: Record<string, unknown>}, messageId = this.messageId): Promise<void> {
        // An older turn's idle that lands after the next prompt started must not end the new turn.
        if (messageId !== this.messageId) return;
        if (this.terminalAttempted) return;
        this.terminalAttempted = true;
        this.turnActive = false;
        this.waiting = 0;
        const details = {
            ...(extra?.usage === undefined ? {} : {usage: extra.usage}),
            ...(extra?._meta === undefined ? {} : {_meta: extra._meta}),
        };
        const idle = ((): acp.IdleStateUpdate => {
            switch (stopReason) {
                case "error": return {stopReason, ...details, ...(extra?.error === undefined ? {} : {error: extra.error})};
                case "end_turn": return {stopReason, ...details};
                case "cancelled": return {stopReason, ...details};
                case "max_tokens": return {stopReason, ...details};
                case "max_turn_requests": return {stopReason, ...details};
                case "refusal": return {stopReason, ...details};
            }
        })();
        await this.update(this.correlated({sessionUpdate: "state_update", state: "idle", ...idle}));
    }

    /** Turn correlation v2: every state frame of a prompted turn names its prompt's `messageId`. */
    private correlated(update: acp.SessionUpdate): acp.SessionUpdate {
        if (this.messageId === undefined) return update;
        const meta = update._meta as Record<string, unknown> | undefined;
        const alwith = meta?.["alwith"] as Record<string, unknown> | undefined;
        return {...update, _meta: {...meta, alwith: {...alwith, messageId: this.messageId}}};
    }

    private async waitingOnClient<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (this.disposed) throw new Error("Session is closed");
        // An old request may resolve after idle and after a new turn has started.
        const generation = this.turnActive ? this.turnGeneration : null;
        try {
            if (generation !== null && this.waiting++ === 0) {
                const pending = this.state({sessionUpdate: "state_update", state: "requires_action"});
                await (signal ? abortable(pending, signal) : pending);
            }
            return await operation();
        } finally {
            if (this.turnActive && generation === this.turnGeneration && --this.waiting === 0) {
                const pending = this.state({sessionUpdate: "state_update", state: "running"});
                await (signal ? abortable(pending, signal).catch(() => {}) : pending);
            }
        }
    }

    private async state(update: acp.SessionUpdate): Promise<void> {
        try {
            await this.update(this.correlated(update));
        } catch (error) {
            logger.error("Failed to publish session state", error, {sessionId: this.sessionId});
        }
    }

    dispose(): void {
        this.disposed = true;
        this.output.abort();
        this.turnActive = false;
        this.waiting = 0;
    }
}
