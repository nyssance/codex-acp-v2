import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {logger} from "../util/logger";

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

    constructor(
        readonly sessionId: string,
        private readonly link: ClientLink,
        readonly capabilities: ClientCapabilitySet,
    ) {}

    async update(update: acp.SessionUpdate): Promise<void> {
        await this.link.notify(acp.methods.client.session.update, {sessionId: this.sessionId, update});
    }

    async updateAll(updates: readonly acp.SessionUpdate[]): Promise<void> {
        for (const update of updates) await this.update(update);
    }

    async requestPermission(
        request: Omit<acp.RequestPermissionRequest, "sessionId">,
        signal?: AbortSignal,
    ): Promise<acp.RequestPermissionResponse> {
        return await this.waitingOnClient(() => this.link.request(
            acp.methods.client.session.requestPermission,
            {sessionId: this.sessionId, ...request},
            signal ? {cancellationSignal: signal} : undefined,
        ));
    }

    async createElicitation(request: acp.CreateElicitationRequest, signal?: AbortSignal): Promise<acp.CreateElicitationResponse> {
        return await this.waitingOnClient(() => this.link.request(
            acp.methods.client.elicitation.create,
            request,
            signal ? {cancellationSignal: signal} : undefined,
        ));
    }

    async completeElicitation(elicitationId: string): Promise<void> {
        await this.link.notify(acp.methods.client.elicitation.complete, {elicitationId});
    }

    /** Foreground work started: report `running` (fire-and-forget, the frame is already queued). */
    reportRunning(): void {
        this.turnActive = true;
        this.waiting = 0;
        void this.state({sessionUpdate: "state_update", state: "running"});
    }

    async reportIdle(stopReason: acp.StopReason, extra?: {usage?: acp.Usage | null; _meta?: Record<string, unknown>}): Promise<void> {
        this.turnActive = false;
        this.waiting = 0;
        await this.update({
            sessionUpdate: "state_update",
            state: "idle",
            stopReason,
            ...(extra?.usage === undefined ? {} : {usage: extra.usage}),
            ...(extra?._meta === undefined ? {} : {_meta: extra._meta}),
        });
    }

    private async waitingOnClient<T>(operation: () => Promise<T>): Promise<T> {
        if (this.turnActive && this.waiting++ === 0) {
            await this.state({sessionUpdate: "state_update", state: "requires_action"});
        }
        try {
            return await operation();
        } finally {
            if (this.turnActive && --this.waiting === 0) {
                await this.state({sessionUpdate: "state_update", state: "running"});
            }
            if (this.waiting < 0) this.waiting = 0;
        }
    }

    private async state(update: acp.SessionUpdate): Promise<void> {
        try {
            await this.update(update);
        } catch (error) {
            logger.error("Failed to publish session state", error, {sessionId: this.sessionId});
        }
    }
}
