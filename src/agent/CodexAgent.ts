import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import path from "node:path";
import type {ServerNotification} from "../app-server";
import type {Thread, Turn, TurnCompletedNotification, TurnError} from "../app-server/v2";
import {EventBridge, type CompletedPlan} from "../bridge/EventBridge";
import {mcpStartupFailed, ToolName} from "../bridge/toolCalls";
import type {AppServerClient} from "../codex/AppServerClient";
import type {CodexProcess} from "../codex/process";
import {initialAgentMode, withWritableRoots} from "../codex/modes";
import {
    DEFAULT_COLLABORATION_MODE,
    FAST_SERVICE_TIER,
    findModel,
    modelLacksReasoning,
    modelSupportsImages,
    PLAN_COLLABORATION_MODE,
    resolveModelSelection,
} from "../codex/models";
import {
    buildThreadConfig,
    isJsonObject,
    promptTitle,
    readAdditionalDirectories,
    sanitizeMcpServerName,
    toUserInput,
    type JsonObject,
} from "../codex/sessionConfig";
import {CodexApprovalHandler} from "../permissions/ApprovalHandler";
import {CodexElicitationHandler} from "../permissions/ElicitationHandler";
import {TurnContext} from "../permissions/turnContext";
import {errorMessage, logger} from "../util/logger";
import {toAcpUsage} from "../util/tokens";
import {authMethods, authRequired, login, logout} from "./auth";
import {ClientSession, type ClientCapabilitySet, type ClientLink} from "./clientSession";
import {availableCommands, mcpMessage, parseCommand, resolveCommand, skillsMessage, statusMessage} from "./commands";
import {applyConfigOption, sessionConfigOptions} from "./configOptions";
import {historyTitle, historyUpdates} from "./history";
import {ProviderRouting} from "./providers";
import {createActiveTurn, type ActiveTurn, type Session} from "./session";

export interface CodexAgentOptions {
    codex: AppServerClient;
    process?: CodexProcess;
    /** JSON object merged into every thread's Codex config (from `CODEX_CONFIG`). */
    config?: JsonObject;
    /** Codex model provider for new threads (from `MODEL_PROVIDER`). */
    modelProvider?: string;
    info: acp.Implementation;
    env?: NodeJS.ProcessEnv;
}

interface SessionRuntime {
    session: Session;
    client: ClientSession;
    bridge: EventBridge;
    turnContext: TurnContext;
    elicitation: CodexElicitationHandler;
    /** Serializes notification handling so frames reach the client in Codex order. */
    queue: Promise<void>;
}

type OpenRequest =
    | {kind: "new"; request: acp.NewSessionRequest}
    | {kind: "resume"; request: acp.ResumeSessionRequest}
    | {kind: "fork"; request: acp.ForkSessionRequest};

const CLOSE_TURN_GRACE_MS = 5_000;
const HISTORY_PAGE_SIZE = 50;
/** Custom stop reason (`_`-prefixed per ACP extensibility) for a turn Codex reported as failed. */
export const ERROR_STOP_REASON = "_error";
const IMPLEMENT_PLAN_OPTION = "implement_plan";
const REVISE_PLAN_OPTION = "revise_plan";

/**
 * Native ACP v2 agent for the Codex app-server. One instance serves one client
 * connection; sessions map one-to-one onto Codex threads.
 */
export class CodexAgent {
    private readonly codex: AppServerClient;
    private readonly process: CodexProcess | null;
    private readonly providers: ProviderRouting;
    private readonly info: acp.Implementation;
    private readonly env: NodeJS.ProcessEnv;
    private readonly sessions = new Map<string, SessionRuntime>();
    private capabilities: ClientCapabilitySet | null = null;
    private codexInitialized = false;
    private skillRoots: string[] = [];

    constructor(private readonly link: ClientLink, options: CodexAgentOptions) {
        this.codex = options.codex;
        this.process = options.process ?? null;
        this.providers = new ProviderRouting(options.config ?? {}, options.modelProvider ?? null);
        this.info = options.info;
        this.env = options.env ?? process.env;
        void this.process?.exited.then(() => this.handleCodexExit());
        this.codex.connection.onClose(() => this.handleCodexExit());
    }

    // ---- initialize -----------------------------------------------------------

    async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
        if (params.protocolVersion !== acp.PROTOCOL_VERSION) {
            throw acp.RequestError.invalidParams(
                {protocolVersion: params.protocolVersion},
                `Unsupported protocol version ${params.protocolVersion}; this agent speaks ACP v${acp.PROTOCOL_VERSION}`,
            );
        }
        this.capabilities = {
            formElicitation: params.capabilities?.elicitation?.form != null,
            urlElicitation: params.capabilities?.elicitation?.url != null,
        };
        // Clients re-send initialize when they re-attach; Codex accepts it only once per process.
        if (!this.codexInitialized) {
            await this.withCodex(() => this.codex.initialize({
                clientInfo: {name: params.info.name, title: params.info.title ?? null, version: params.info.version},
                capabilities: {experimentalApi: true, requestAttestation: false},
            }));
            this.codexInitialized = true;
        }
        return {
            protocolVersion: acp.PROTOCOL_VERSION,
            info: this.info,
            capabilities: {
                session: {
                    prompt: {image: {}, embeddedContext: {}},
                    mcp: {stdio: {}, http: {}},
                    fork: {},
                    delete: {},
                    additionalDirectories: {},
                },
                providers: {},
            },
            authMethods: authMethods(this.capabilities, this.env),
        };
    }

    private requireInitialized(method: string): ClientCapabilitySet {
        if (this.capabilities === null) {
            throw acp.RequestError.invalidRequest(
                {method},
                `${method} requires a successful initialize first: send {"protocolVersion": ${acp.PROTOCOL_VERSION}, "info": {"name": ..., "version": ...}}`,
            );
        }
        return this.capabilities;
    }

    // ---- auth -------------------------------------------------------------------

    async login(params: acp.LoginAuthRequest, requestId: acp.JsonRpcId | null = null): Promise<acp.LoginAuthResponse> {
        this.requireInitialized("auth/login");
        await this.withCodex(() => login(this.codex, this.link, params, requestId, this.env));
        await this.refreshAccounts();
        return {};
    }

    async logout(_params: acp.LogoutAuthRequest): Promise<acp.LogoutAuthResponse> {
        this.requireInitialized("auth/logout");
        await this.withCodex(() => logout(this.codex));
        await this.refreshAccounts();
        return {};
    }

    private async refreshAccounts(): Promise<void> {
        const account = (await this.codex.accountRead({refreshToken: false})).account;
        for (const runtime of this.sessions.values()) runtime.session.account = account;
    }

    // ---- providers ----------------------------------------------------------------

    listProviders(_params: acp.ListProvidersRequest): acp.ListProvidersResponse {
        this.requireInitialized("providers/list");
        return this.providers.list();
    }

    async setProvider(params: acp.SetProviderRequest): Promise<acp.SetProviderResponse> {
        this.requireInitialized("providers/set");
        this.assertNoActiveTurns("providers/set");
        this.providers.set(params);
        await this.rebindSessions();
        return {};
    }

    async disableProvider(params: acp.DisableProviderRequest): Promise<acp.DisableProviderResponse> {
        this.requireInitialized("providers/disable");
        this.assertNoActiveTurns("providers/disable");
        this.providers.disable(params);
        await this.rebindSessions();
        return {};
    }

    private assertNoActiveTurns(method: string): void {
        const busy = [...this.sessions.values()].filter(runtime => runtime.session.activeTurn !== null).map(runtime => runtime.session.id);
        if (busy.length > 0) {
            throw acp.RequestError.invalidRequest({sessions: busy}, `${method} cannot change routing while a turn is running; cancel it or wait for idle`);
        }
    }

    /**
     * Provider routing is a thread property in Codex, so every open session is
     * resumed in place with the new `model_providers` config. Codex rejoins the
     * live thread; history and subscriptions survive.
     */
    private async rebindSessions(): Promise<void> {
        const gateway = this.providers.active;
        for (const runtime of this.sessions.values()) {
            const {session} = runtime;
            const config = buildThreadConfig(this.providers.threadConfig(), session.cwd, session.additionalDirectories, [], new Set());
            const thread = await this.withCodex(() => this.codex.threadResume({
                threadId: session.id,
                cwd: session.cwd,
                config,
                modelProvider: this.providers.modelProvider(),
                excludeTurns: true,
            }));
            const codexCatalog = await this.withCodex(() => this.codex.allModels());
            session.catalog = this.providers.catalog(codexCatalog);
            session.model = resolveModelSelection(session.catalog, gateway?.model ?? thread.model, thread.reasoningEffort);
            await runtime.client.update({sessionUpdate: "config_option_update", configOptions: sessionConfigOptions(session)});
        }
    }

    // ---- sessions ---------------------------------------------------------------

    async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
        const runtime = await this.openSession({kind: "new", request: params});
        return {sessionId: runtime.session.id, configOptions: sessionConfigOptions(runtime.session)};
    }

    async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
        const runtime = await this.openSession({kind: "resume", request: params});
        return {configOptions: sessionConfigOptions(runtime.session)};
    }

    async forkSession(params: acp.ForkSessionRequest): Promise<acp.ForkSessionResponse> {
        const runtime = await this.openSession({kind: "fork", request: params});
        return {sessionId: runtime.session.id, configOptions: sessionConfigOptions(runtime.session)};
    }

    private async openSession(open: OpenRequest): Promise<SessionRuntime> {
        const method = {new: "session/new", resume: "session/resume", fork: "session/fork"}[open.kind];
        const capabilities = this.requireInitialized(method);
        const {request} = open;
        if (typeof request.cwd !== "string" || !path.isAbsolute(request.cwd)) {
            throw acp.RequestError.invalidParams({cwd: request.cwd}, "cwd must be an absolute path");
        }
        if (open.kind !== "new" && this.sessions.has(open.request.sessionId)) {
            // A second open for a live session replaces it; close the old runtime first.
            await this.closeRuntime(open.request.sessionId);
        }
        const additionalDirectories = readAdditionalDirectories(request.cwd, request.additionalDirectories);
        const mcpServers = request.mcpServers ?? [];

        // A client-configured gateway carries its own credentials; only native OpenAI routing needs a login.
        if (this.providers.active === null && await this.withCodex(() => authRequired(this.codex))) {
            throw acp.RequestError.authRequired(undefined, "Log in to Codex first (auth/login)");
        }
        await this.withCodex(() => this.refreshSkills(request.cwd, additionalDirectories));
        const existingMcp = mcpServers.length > 0 ? await this.withCodex(() => this.configuredMcpServerNames(request.cwd)) : new Set<string>();
        const config = buildThreadConfig(this.providers.threadConfig(), request.cwd, additionalDirectories, mcpServers, existingMcp);
        const mcpStartupGeneration = this.codex.mcpStartupGeneration;
        const modelProvider = await this.withCodex(() => this.resolveModelProvider());

        const thread = await this.withCodex(async () => {
            switch (open.kind) {
                case "new":
                    return await this.codex.threadStart({config, cwd: request.cwd, modelProvider});
                case "resume":
                    // History is paged through thread/turns/list during replay; full hydration here is deprecated.
                    return await this.codex.threadResume({threadId: open.request.sessionId, config, cwd: request.cwd, modelProvider, excludeTurns: true});
                case "fork":
                    return await this.codex.threadFork({threadId: open.request.sessionId, config, cwd: request.cwd, modelProvider, excludeTurns: true});
            }
        });
        const sessionId = thread.thread.id;
        try {
            const [codexCatalog, account] = await this.withCodex(() => Promise.all([
                this.codex.allModels(),
                this.codex.accountRead({refreshToken: false}),
            ]));
            const gateway = this.providers.active;
            const catalog = this.providers.catalog(codexCatalog);
            const model = resolveModelSelection(catalog, gateway?.model ?? thread.model, thread.reasoningEffort);
            const session: Session = {
                id: sessionId,
                cwd: request.cwd,
                additionalDirectories,
                mcpServerNames: mcpServerNames(mcpServers),
                catalog,
                model,
                mode: initialAgentMode(this.env),
                collaborationMode: DEFAULT_COLLABORATION_MODE,
                fastMode: thread.serviceTier === FAST_SERVICE_TIER,
                account: account.account,
                title: null,
                titleIsExplicit: false,
                activeTurn: null,
                lastUsage: null,
                contextWindow: null,
                closed: false,
            };
            const runtime = this.installRuntime(session, capabilities);
            const replay = open.kind === "fork" || (open.kind === "resume" && open.request.replayFrom?.type === "start");
            if (open.kind === "resume" && open.request.replayFrom != null && open.request.replayFrom.type !== "start") {
                throw acp.RequestError.invalidParams({replayFrom: open.request.replayFrom}, "Only replayFrom {type: \"start\"} is supported");
            }
            if (open.kind !== "new") {
                await this.replayHistory(runtime, replay, thread.thread);
            }
            if (mcpServers.length > 0) void this.reportMcpStartup(runtime, mcpStartupGeneration);
            void this.publishAvailableCommands(runtime);
            return runtime;
        } catch (error) {
            // The thread is loaded and subscribed on the Codex side; do not leak it.
            this.sessions.delete(sessionId);
            this.codex.detachThread(sessionId);
            await this.codex.threadUnsubscribe({threadId: sessionId}).catch(() => {});
            throw error;
        }
    }

    private installRuntime(session: Session, capabilities: ClientCapabilitySet): SessionRuntime {
        const client = new ClientSession(session.id, this.link, capabilities);
        const bridge = new EventBridge(client, session);
        const turnContext = new TurnContext(session.id);
        const signal = () => session.activeTurn?.abort.signal;
        const approval = new CodexApprovalHandler(client, turnContext, signal);
        const elicitation = new CodexElicitationHandler(client, turnContext, signal);
        const runtime: SessionRuntime = {session, client, bridge, turnContext, elicitation, queue: Promise.resolve()};
        // Frames already queued (e.g. the tool call under review) must reach the client before its prompt.
        const drained = <P, T>(operation: (params: P) => Promise<T>) => async (params: P): Promise<T> => {
            await this.drain(runtime);
            return await operation(params);
        };
        this.codex.attachThread(session.id, {
            notification: (notification) => this.enqueue(runtime, notification),
            approval: {
                handleCommandExecution: drained(params => approval.handleCommandExecution(params)),
                handleFileChange: drained(params => approval.handleFileChange(params)),
                handlePermissionsRequest: drained(params => approval.handlePermissionsRequest(params)),
            },
            elicitation: {
                handleElicitation: drained(params => elicitation.handleElicitation(params)),
                handleUserInput: drained(params => elicitation.handleUserInput(params)),
            },
        });
        this.sessions.set(session.id, runtime);
        return runtime;
    }

    private enqueue(runtime: SessionRuntime, notification: ServerNotification): void {
        const run = async () => {
            try {
                runtime.turnContext.observe(notification);
                await runtime.elicitation.observe(notification);
                await runtime.bridge.handle(notification);
            } catch (error) {
                logger.error("notification handling failed", error, {sessionId: runtime.session.id, method: notification.method});
            }
        };
        runtime.queue = runtime.queue.then(run, run);
    }

    private async drain(runtime: SessionRuntime): Promise<void> {
        let current: Promise<void>;
        do {
            current = runtime.queue;
            await current;
        } while (runtime.queue !== current);
    }

    /**
     * Publishes the session title and, when asked, replays the transcript. Turns are
     * paged through thread/turns/list and streamed page by page, so a long session
     * never needs to be materialized in one response.
     */
    private async replayHistory(runtime: SessionRuntime, replay: boolean, thread: Thread): Promise<void> {
        const {session, client} = runtime;
        let titlePublished = false;
        const publishTitle = async (turns: readonly Turn[]) => {
            if (titlePublished) return;
            const title = historyTitle(thread, turns);
            if (title === null && replay) return;
            titlePublished = true;
            session.title = title;
            session.titleIsExplicit = !!thread.name?.trim();
            if (title) await client.update({sessionUpdate: "session_info_update", title});
        };
        if (!replay) {
            const firstPage = thread.name?.trim() ? {data: [] as Turn[]} : await this.turnPage(session.id, null);
            await publishTitle(firstPage.data);
            return;
        }
        let cursor: string | null = null;
        do {
            const page: {data: Turn[]; nextCursor: string | null} = await this.turnPage(session.id, cursor);
            await publishTitle(page.data);
            await client.updateAll(historyUpdates(page.data));
            cursor = page.nextCursor;
        } while (cursor !== null && !session.closed);
        await publishTitle([]);
    }

    private async turnPage(threadId: string, cursor: string | null): Promise<{data: Turn[]; nextCursor: string | null}> {
        const page = await this.withCodex(() => this.codex.threadTurnsList({threadId, cursor, limit: HISTORY_PAGE_SIZE, sortDirection: "asc", itemsView: "full"}));
        return {data: page.data, nextCursor: page.nextCursor};
    }

    private async reportMcpStartup(runtime: SessionRuntime, afterGeneration: number): Promise<void> {
        try {
            const result = await this.codex.awaitMcpStartup(runtime.session.mcpServerNames, afterGeneration);
            if (runtime.session.closed) return;
            for (const failure of result.failed) {
                await runtime.client.update(mcpStartupFailed(failure.server, `MCP server "${failure.server}" failed to start: ${failure.error}`));
            }
            for (const server of result.cancelled) {
                await runtime.client.update(mcpStartupFailed(server, `MCP server "${server}" startup was cancelled.`));
            }
        } catch (error) {
            logger.error("MCP startup reporting failed", error, {sessionId: runtime.session.id});
        }
    }

    private async publishAvailableCommands(runtime: SessionRuntime): Promise<void> {
        try {
            const skills = await this.codex.skillsList({cwds: [runtime.session.cwd, ...runtime.session.additionalDirectories]});
            if (runtime.session.closed) return;
            await runtime.client.update({sessionUpdate: "available_commands_update", availableCommands: availableCommands(skills.data)});
        } catch (error) {
            logger.error("publishing available commands failed", error, {sessionId: runtime.session.id});
        }
    }

    async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        this.requireInitialized("session/list");
        const cwd = params.cwd?.trim() || null;
        const response = await this.withCodex(() => this.codex.threadList({
            cursor: params.cursor ?? null,
            ...(cwd ? {cwd} : {}),
            sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
        }));
        return {
            sessions: response.data.map(thread => ({
                sessionId: thread.id,
                cwd: thread.cwd,
                title: thread.name?.trim() || thread.preview.trim() || null,
                updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
            })),
            nextCursor: response.nextCursor,
        };
    }

    async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
        this.requireInitialized("session/close");
        await this.closeRuntime(params.sessionId);
        return {};
    }

    async deleteSession(params: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
        this.requireInitialized("session/delete");
        await this.closeRuntime(params.sessionId);
        await this.withCodex(() => this.codex.threadArchive({threadId: params.sessionId}));
        return {};
    }

    private async closeRuntime(sessionId: string): Promise<void> {
        const runtime = this.sessions.get(sessionId);
        if (!runtime) return;
        runtime.session.closed = true;
        const turn = runtime.session.activeTurn;
        if (turn) {
            await this.interruptTurn(runtime, turn);
            const timeout = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), CLOSE_TURN_GRACE_MS).unref());
            if (await Promise.race([turn.finished.then(() => "finished" as const), timeout]) === "timeout" && turn.turnId) {
                this.codex.resolveTurnInterrupted(turn.threadId, turn.turnId);
                await turn.finished;
            }
        }
        this.sessions.delete(sessionId);
        this.codex.detachThread(sessionId);
        runtime.bridge.dispose();
        await this.codex.threadUnsubscribe({threadId: sessionId}).catch(error => {
            logger.error("thread/unsubscribe failed", error, {sessionId});
        });
    }

    async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
        const runtime = this.runtime(params.sessionId, "session/set_config_option");
        await this.withCodex(() => applyConfigOption(runtime.session, this.codex, params));
        const configOptions = sessionConfigOptions(runtime.session);
        await runtime.client.update({sessionUpdate: "config_option_update", configOptions});
        return {configOptions};
    }

    private runtime(sessionId: string, method: string): SessionRuntime {
        this.requireInitialized(method);
        const runtime = this.sessions.get(sessionId);
        if (!runtime) throw acp.RequestError.invalidParams({sessionId}, `Unknown session "${sessionId}"`);
        return runtime;
    }

    // ---- prompts ------------------------------------------------------------------

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
        const runtime = this.runtime(params.sessionId, "session/prompt");
        const {session} = runtime;
        if (!Array.isArray(params.prompt) || params.prompt.length === 0) {
            throw acp.RequestError.invalidParams(undefined, "prompt must contain at least one content block");
        }
        if (session.activeTurn) {
            return await this.steerActiveTurn(runtime, session.activeTurn, params);
        }
        const model = findModel(session.catalog, session.model.model);
        if (!modelSupportsImages(model) && params.prompt.some(block => block.type === "image")) {
            throw acp.RequestError.invalidParams({model: session.model.model}, "The current model does not support image input");
        }
        const turn = createActiveTurn(session.id);
        session.activeTurn = turn;
        runtime.client.reportRunning();
        void this.runPrompt(runtime, turn, params);
        return {};
    }

    /** A prompt during a running turn is injected into it; Codex calls this steering. */
    private async steerActiveTurn(runtime: SessionRuntime, turn: ActiveTurn, params: acp.PromptRequest): Promise<acp.PromptResponse> {
        const turnId = turn.turnId ?? await turn.started;
        if (turnId === null || turn.threadId !== runtime.session.id) {
            throw acp.RequestError.invalidRequest({sessionId: params.sessionId}, "A turn is already running; wait for it to finish or cancel it");
        }
        try {
            await this.codex.turnSteer({threadId: runtime.session.id, expectedTurnId: turnId, input: toUserInput(params.prompt)});
            return {_meta: {codex: {steered: turnId}}};
        } catch (error) {
            throw acp.RequestError.invalidRequest({sessionId: params.sessionId, turnId}, `Could not steer the running turn: ${errorMessage(error)}`);
        }
    }

    private async runPrompt(runtime: SessionRuntime, turn: ActiveTurn, params: acp.PromptRequest): Promise<void> {
        const {session, client, bridge} = runtime;
        bridge.beginTurn();
        try {
            const command = parseCommand(params.prompt);
            const outcome = command ? resolveCommand(command, session) : {kind: "prompt" as const};
            let completed: TurnCompletedNotification | null = null;
            switch (outcome.kind) {
                case "prompt":
                    completed = await this.runCodexTurn(runtime, turn, params.prompt);
                    break;
                case "message":
                    await client.update(agentMessage(`command:${command?.name}:${Date.now()}`, await this.commandText(runtime, command?.name ?? "", outcome.text)));
                    break;
                case "config":
                    await this.setSessionConfigOption({sessionId: session.id, configId: outcome.configId, type: "id", value: outcome.value});
                    break;
                case "compact":
                    await this.runCompaction(runtime, turn);
                    break;
                case "review":
                    completed = await this.withCodex(() => this.codex.runReview({threadId: session.id, target: outcome.target, delivery: "inline"}, (turnId, threadId) => {
                        turn.turnId = turnId;
                        turn.threadId = threadId;
                        turn.resolveStarted(turnId);
                    }));
                    break;
                case "logout":
                    await this.withCodex(() => logout(this.codex));
                    await this.refreshAccounts();
                    await client.update(agentMessage(`command:logout:${Date.now()}`, "Logged out of the Codex account."));
                    break;
            }
            await this.drain(runtime);
            await bridge.flush();

            if (completed?.turn.status === "completed" && !turn.abort.signal.aborted) {
                completed = await this.maybeImplementPlan(runtime, turn, completed);
            }
            if (completed?.turn.status === "interrupted" || turn.abort.signal.aborted) {
                await bridge.cancelOpenToolCalls();
                await client.reportIdle("cancelled", {usage: usageOf(session)});
                return;
            }
            if (completed?.turn.status === "failed") {
                await this.reportTurnFailure(runtime, completed.turn.error ?? bridge.takeError() ?? {message: "Turn failed", codexErrorInfo: null, additionalDetails: null, misalignment: null});
                return;
            }
            const pendingError = bridge.takeError();
            if (pendingError) {
                await this.reportTurnFailure(runtime, pendingError);
                return;
            }
            await this.publishFallbackTitle(runtime, promptTitle(params.prompt));
            await client.reportIdle("end_turn", {usage: usageOf(session)});
        } catch (error) {
            if (turn.abort.signal.aborted || session.closed) {
                await bridge.cancelOpenToolCalls().catch(() => {});
                await client.reportIdle("cancelled", {usage: usageOf(session)}).catch(() => {});
                return;
            }
            logger.error("prompt failed", error, {sessionId: session.id});
            await this.reportTurnFailure(runtime, {message: this.describeFailure(error), codexErrorInfo: null, additionalDetails: null, misalignment: null}).catch(() => {});
        } finally {
            turn.resolveStarted(null);
            if (session.activeTurn === turn) session.activeTurn = null;
            turn.resolveFinished();
        }
    }

    private async runCodexTurn(runtime: SessionRuntime, turn: ActiveTurn, prompt: readonly acp.ContentBlock[]): Promise<TurnCompletedNotification> {
        const {session} = runtime;
        const model = findModel(session.catalog, session.model.model);
        const disableSummary = session.account?.type === "apiKey" || modelLacksReasoning(model);
        await this.withCodex(() => this.refreshSkills(session.cwd, session.additionalDirectories));
        if (turn.abort.signal.aborted) {
            return interruptedTurn(session.id);
        }
        return await this.withCodex(() => this.codex.runTurn({
            threadId: session.id,
            input: toUserInput(prompt),
            approvalPolicy: session.mode.approvalPolicy,
            approvalsReviewer: session.mode.approvalsReviewer,
            sandboxPolicy: withWritableRoots(session.mode.sandboxPolicy, session.additionalDirectories),
            model: session.model.model,
            effort: session.model.effort,
            summary: disableSummary ? "none" : "auto",
            serviceTier: session.fastMode ? FAST_SERVICE_TIER : null,
        }, (turnId) => {
            // A cancel that raced turn/start is parked on `started` and interrupts from there.
            turn.turnId = turnId;
            turn.resolveStarted(turnId);
        }));
    }

    private async runCompaction(runtime: SessionRuntime, turn: ActiveTurn): Promise<void> {
        const threadId = runtime.session.id;
        const completed = Promise.race([
            this.codex.awaitNotification("item/completed", params => params.threadId === threadId && params.item.type === "contextCompaction"),
            this.codex.awaitNotification("thread/compacted", params => params.threadId === threadId),
        ]);
        await this.withCodex(() => this.codex.threadCompactStart({threadId}));
        turn.resolveStarted(null);
        await completed;
    }

    /** In plan collaboration mode a finished plan asks the user whether to implement it now. */
    private async maybeImplementPlan(runtime: SessionRuntime, turn: ActiveTurn, completed: TurnCompletedNotification): Promise<TurnCompletedNotification> {
        const plan = runtime.bridge.takeCompletedPlan();
        if (!plan || runtime.session.collaborationMode !== PLAN_COLLABORATION_MODE) return completed;
        const approved = await this.requestPlanApproval(runtime, plan, turn.abort.signal);
        if (!approved || turn.abort.signal.aborted) return completed;
        await this.setSessionConfigOption({sessionId: runtime.session.id, configId: "collaboration_mode", type: "id", value: DEFAULT_COLLABORATION_MODE});
        runtime.bridge.beginTurn();
        turn.turnId = null;
        const implementation = await this.runCodexTurn(runtime, turn, [{type: "text", text: "Implement the approved plan."}]);
        await this.drain(runtime);
        await runtime.bridge.flush();
        return implementation;
    }

    private async requestPlanApproval(runtime: SessionRuntime, plan: CompletedPlan, signal: AbortSignal): Promise<boolean> {
        const toolCallId = `plan-review:${plan.itemId}`;
        try {
            const response = await runtime.client.requestPermission({
                title: "Implement this plan?",
                subject: {
                    type: "tool_call",
                    toolCall: {toolCallId, name: ToolName.PlanReview, title: "Implement this plan?", kind: "switch_mode", status: "pending", rawInput: {plan: plan.text}},
                },
                options: [
                    {optionId: IMPLEMENT_PLAN_OPTION, name: "Yes, implement this plan", kind: "allow_once"},
                    {optionId: REVISE_PLAN_OPTION, name: "No, and tell Codex what to do differently", kind: "reject_once"},
                ],
                _meta: {codex: {kind: "plan_review", planItemId: plan.itemId}},
            }, signal);
            const approved = response.outcome.outcome === "selected" && (response.outcome as {optionId?: unknown}).optionId === IMPLEMENT_PLAN_OPTION;
            await runtime.client.update({
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: "completed",
                rawOutput: approved ? "User approved the plan." : "User kept the session in plan mode.",
            });
            return approved;
        } catch (error) {
            logger.error("plan approval failed", error, {sessionId: runtime.session.id});
            return false;
        }
    }

    private async commandText(runtime: SessionRuntime, name: string, fallback: string): Promise<string> {
        switch (name) {
            case "status":
                return statusMessage(runtime.session, runtime.bridge.rateLimits);
            case "mcp":
                return await this.withCodex(() => mcpMessage(this.codex, runtime.session));
            case "skills": {
                const skills = await this.withCodex(() => this.codex.skillsList({cwds: [runtime.session.cwd, ...runtime.session.additionalDirectories]}));
                return skillsMessage(skills.data);
            }
            default:
                return fallback;
        }
    }

    private async reportTurnFailure(runtime: SessionRuntime, error: TurnError): Promise<void> {
        const message = error.additionalDetails ? `${error.message}\n\n${error.additionalDetails}` : error.message;
        await runtime.client.update({
            sessionUpdate: "agent_message_chunk",
            messageId: `codex-error:${runtime.session.id}:${Date.now()}`,
            content: {type: "text", text: message},
            _meta: {codex: {error: {message: error.message, codexErrorInfo: error.codexErrorInfo, additionalDetails: error.additionalDetails}}},
        });
        await runtime.client.reportIdle(ERROR_STOP_REASON, {
            usage: usageOf(runtime.session),
            _meta: {codex: {error: {message: error.message, codexErrorInfo: error.codexErrorInfo}}},
        });
    }

    private async publishFallbackTitle(runtime: SessionRuntime, title: string | null): Promise<void> {
        const {session, client} = runtime;
        if (session.titleIsExplicit || session.title !== null || title === null) return;
        session.title = title;
        await client.update({sessionUpdate: "session_info_update", title});
    }

    async cancel(params: acp.CancelSessionNotification): Promise<void> {
        const runtime = this.sessions.get(params.sessionId);
        const turn = runtime?.session.activeTurn;
        if (!runtime || !turn) return;
        await this.interruptTurn(runtime, turn);
    }

    private async interruptTurn(runtime: SessionRuntime, turn: ActiveTurn): Promise<void> {
        turn.abort.abort();
        const turnId = turn.turnId ?? await turn.started;
        if (turnId === null) return;
        try {
            await this.codex.turnInterrupt({threadId: turn.threadId, turnId});
        } catch (error) {
            logger.error("turn/interrupt failed", error, {sessionId: runtime.session.id, turnId});
        }
    }

    // ---- helpers ------------------------------------------------------------------

    private async refreshSkills(cwd: string, additionalDirectories: readonly string[]): Promise<void> {
        const roots = additionalDirectories.map(root => path.join(root, ".agents", "skills"));
        if (roots.length !== this.skillRoots.length || roots.some((root, index) => root !== this.skillRoots[index])) {
            await this.codex.skillsExtraRootsSet({extraRoots: roots});
            this.skillRoots = roots;
        }
        await this.codex.skillsList({cwds: [cwd, ...additionalDirectories], forceReload: true});
    }

    private async configuredMcpServerNames(cwd: string): Promise<Set<string>> {
        const response = await this.codex.configRead({includeLayers: true, cwd});
        const names = new Set<string>();
        const sources = [response.config["mcp_servers"], ...(response.layers ?? []).map(layer => isJsonObject(layer.config) ? layer.config["mcp_servers"] : undefined)];
        for (const source of sources) {
            if (isJsonObject(source)) for (const name of Object.keys(source)) names.add(name);
        }
        return names;
    }

    private async resolveModelProvider(): Promise<string | null> {
        const routed = this.providers.modelProvider();
        if (routed) return routed;
        const config = await this.codex.configRead({includeLayers: false});
        const provider = config.config["model_provider"];
        return typeof provider === "string" && provider.length > 0 ? provider : null;
    }

    /** Runs a Codex request, replacing a dead-process transport error with a diagnosable one. */
    private async withCodex<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (error instanceof acp.RequestError) throw error;
            const exitCode = this.process?.exitCode() ?? null;
            if (exitCode !== null) {
                const stderr = this.process?.recentStderr() ?? "";
                throw acp.RequestError.internalError(
                    {exitCode, stderr},
                    exitCode === 3221225781
                        ? "Codex exited: the Visual C++ redistributable is not installed"
                        : `Codex process exited with code ${exitCode}${stderr ? `:\n${stderr}` : ""}`,
                );
            }
            throw acp.RequestError.internalError({details: errorMessage(error)}, errorMessage(error));
        }
    }

    private describeFailure(error: unknown): string {
        if (error instanceof acp.RequestError) {
            const details = (error.data as {details?: unknown} | undefined)?.details;
            return typeof details === "string" && details.length > 0 ? details : error.message;
        }
        return errorMessage(error);
    }

    private exitHandled = false;

    private handleCodexExit(): void {
        if (this.exitHandled) return;
        this.exitHandled = true;
        for (const runtime of this.sessions.values()) {
            const turn = runtime.session.activeTurn;
            if (!turn) continue;
            turn.resolveStarted(null);
            if (turn.turnId) {
                this.codex.failTurn(turn.threadId, turn.turnId, {
                    message: "Connection to Codex was lost",
                    codexErrorInfo: null,
                    additionalDetails: this.process?.recentStderr() || null,
                    misalignment: null,
                });
            }
        }
    }
}

function mcpServerNames(servers: readonly acp.McpServer[]): string[] {
    return servers.flatMap(server => typeof server.name === "string" ? [sanitizeMcpServerName(server.name)] : []);
}

function agentMessage(messageId: string, text: string): acp.SessionUpdate {
    return {sessionUpdate: "agent_message_chunk", messageId, content: {type: "text", text}};
}

function usageOf(session: Session): acp.Usage | null {
    return session.lastUsage ? toAcpUsage(session.lastUsage) : null;
}

function interruptedTurn(threadId: string): TurnCompletedNotification {
    return {
        threadId,
        turn: {id: "", items: [], itemsView: "notLoaded", status: "interrupted", error: null, startedAt: null, completedAt: null, durationMs: null},
    };
}

