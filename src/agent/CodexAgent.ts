import type {ThreadItem} from "../app-server/v2";
import {classifyTurnError} from "./turnErrors";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {JsonValue} from "../app-server/serde_json/JsonValue";
import path from "node:path";
import type {ServerNotification} from "../app-server";
import type {
    MarketplaceAddParams,
    MarketplaceAddResponse,
    MarketplaceRemoveParams,
    MarketplaceUpgradeParams,
    MarketplaceUpgradeResponse,
    PluginInstallParams,
    PluginInstallResponse,
    PluginInstalledParams,
    PluginInstalledResponse,
    PluginListParams,
    PluginListResponse,
    PluginReadParams,
    PluginReadResponse,
    PluginUninstallParams,
    SkillsConfigWriteParams,
    SkillsConfigWriteResponse,
    SkillsListParams,
    SkillsListResponse,
    Thread,
    Turn,
    TurnCompletedNotification,
    TurnError,
} from "../app-server/v2";
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
import {abortable} from "../util/abort";
import {authMethods, login, logout} from "./auth";
import {ClientSession, type ClientCapabilitySet, type ClientLink} from "./clientSession";
import {availableCommands, mcpMessage, parseCommand, resolveCommand, skillsMessage, statusMessage} from "./commands";
import {applyConfigOption, sessionConfigOptions} from "./configOptions";
import {historyTitle, historyUpdates} from "./history";
import {OPENAI_PROVIDER_ID, ProviderRouting} from "./providers";
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
    /** Total local close budget, including turn finalization and remote unsubscribe. */
    closeGraceMs?: number;
}

interface SessionRuntime {
    config: JsonObject;
    modelProvider: string | null;
    stale: boolean;
    session: Session;
    client: ClientSession;
    bridge: EventBridge;
    turnContext: TurnContext;
    elicitation: CodexElicitationHandler;
    lifetime: AbortController;
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
const IMPLEMENT_PLAN_OPTION = "implement_plan";
const REVISE_PLAN_OPTION = "revise_plan";

/**
 * Native ACP v2 agent for the Codex app-server. One instance serves one client
 * connection; sessions map one-to-one onto Codex threads.
 */
export class CodexAgent {
    private readonly codex: AppServerClient;
    private readonly process: CodexProcess | null;
    private providers: ProviderRouting;
    private switching = false;
    private admissions = 0;
    private readonly pendingUnsubscribes = new Map<string, Promise<unknown>>();
    private readonly sessionMutations = new Set<string>();
    private providerQueue: Promise<unknown> = Promise.resolve();
    private readonly info: acp.Implementation;
    private readonly env: NodeJS.ProcessEnv;
    private readonly closeGraceMs: number;
    private readonly sessions = new Map<string, SessionRuntime>();
    private capabilities: ClientCapabilitySet | null = null;
    private codexInitialized = false;
    private initializing: Promise<void> | null = null;
    private readonly terminalTurns = new WeakSet<ActiveTurn>();
    private readonly completedTurns = new WeakMap<ActiveTurn, string>();
    private skillRoots: string[] = [];
    private skillsGeneration = 0;
    private changingSkillRoots = false;
    private readonly publishedSkills = new WeakMap<SessionRuntime, Awaited<ReturnType<AppServerClient["skillsList"]>>>();
    private readonly skillSnapshots = new Map<string, Awaited<ReturnType<AppServerClient["skillsList"]>>>();
    private skillsQueue: Promise<unknown> = Promise.resolve();
    private accountGeneration = 0;

    constructor(private readonly link: ClientLink, options: CodexAgentOptions) {
        this.codex = options.codex;
        this.process = options.process ?? null;
        this.providers = new ProviderRouting(options.config ?? {}, options.modelProvider ?? null);
        this.info = options.info;
        this.env = options.env ?? process.env;
        this.closeGraceMs = options.closeGraceMs ?? CLOSE_TURN_GRACE_MS;
        void this.process?.exited.then(() => this.handleCodexExit());
        this.codex.connection.onClose(() => this.handleCodexExit());
        const stopObserving = this.codex.observeNotifications(notification => {
            if (notification.method === "skills/changed") {
                this.skillsGeneration += 1;
                this.skillSnapshots.clear();
                // Codex emits skills/changed for our own extraRoots/set. Republish here would
                // alternate session roots forever; the current operation already reloads them.
                if (!this.changingSkillRoots) for (const runtime of this.sessions.values()) void this.refreshAvailableCommands(runtime);
                // Hosts with a skills / plugins UI refetch on this one signal.
                this.notifySkillsChanged();
            }
            if (notification.method === "account/updated") void this.refreshAccounts().catch(error => logger.error("refreshing account failed", error));
        });
        this.codex.disconnectSignal.addEventListener("abort", stopObserving, {once: true});
    }

    // ---- initialize -----------------------------------------------------------

    async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
        if (params.protocolVersion !== acp.PROTOCOL_VERSION) {
            throw acp.RequestError.invalidParams(
                {protocolVersion: params.protocolVersion},
                `Unsupported protocol version ${params.protocolVersion}; this agent speaks ACP v${acp.PROTOCOL_VERSION}`,
            );
        }
        const capabilities = {
            formElicitation: params.capabilities?.elicitation?.form != null,
            urlElicitation: params.capabilities?.elicitation?.url != null,
        };
        // Clients re-send initialize when they re-attach; Codex accepts it only once per process.
        if (!this.codexInitialized) {
            this.initializing ??= this.withCodex(async () => {
                await this.codex.initialize({
                    clientInfo: {name: params.info.name, title: params.info.title ?? null, version: params.info.version},
                    capabilities: {experimentalApi: true, requestAttestation: false},
                });
                this.codexInitialized = true;
            }).finally(() => { this.initializing = null; });
            await this.initializing;
        }
        this.capabilities = capabilities;
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
                // Codex desktop's thread model: hide = archive (reversible), delete = delete.
                // ACP has no archive verb, so it rides the `_codex/*` extension surface and is
                // declared here; `session/list` takes `_meta.codex.archived` to page the archive.
                // seedHistory: a host that keeps its own transcript can continue it on a fresh thread —
                // `session/new` with `_meta.codex.seedHistory: [{role, text}]` injects it as model-visible
                // history (thread/inject_items) before the first turn.
                // skills / plugins: the `_codex/skills_*`, `_codex/plugin_*` and `_codex/marketplace_*`
                // pass-through surface for a host that manages Codex's catalogs itself.
                _meta: {codex: {archive: true, seedHistory: true, skills: true, plugins: true}},
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
        this.codex.invalidateModels();
        const generation = ++this.accountGeneration;
        const account = (await this.codex.accountRead({refreshToken: false})).account;
        if (generation !== this.accountGeneration) return;
        for (const runtime of this.sessions.values()) runtime.session.account = account;
    }

    // ---- providers ----------------------------------------------------------------

    listProviders(_params: acp.ListProvidersRequest): acp.ListProvidersResponse {
        this.requireInitialized("providers/list");
        return this.providers.list();
    }

    async setProvider(params: acp.SetProviderRequest): Promise<acp.SetProviderResponse> {
        this.requireInitialized("providers/set");
        await this.changeProvider(candidate => candidate.set(params));
        return {};
    }

    async disableProvider(params: acp.DisableProviderRequest): Promise<acp.DisableProviderResponse> {
        this.requireInitialized("providers/disable");
        if (params.providerId !== OPENAI_PROVIDER_ID) return {};
        await this.changeProvider(candidate => candidate.disable(params));
        return {};
    }

    private assertNoActiveTurns(method: string): void {
        const busy = [...this.sessions.values()].filter(runtime => runtime.session.activeTurn !== null).map(runtime => runtime.session.id);
        if (busy.length > 0) {
            throw acp.RequestError.invalidRequest({sessions: busy}, `${method} cannot change routing while a turn is running; cancel it or wait for idle`);
        }
    }

    private assertRoutingAvailable(): void {
        if (this.switching) throw acp.RequestError.invalidRequest(undefined, "Provider routing is changing; retry after providers/set or providers/disable finishes");
    }

    private async admission<T>(operation: () => Promise<T>, sessionId?: string): Promise<T> {
        this.assertRoutingAvailable();
        if (sessionId && this.sessionMutations.has(sessionId)) throw acp.RequestError.invalidRequest({sessionId}, "Session lifecycle or configuration work is in progress; retry when it finishes");
        if (sessionId) this.sessionMutations.add(sessionId);
        this.admissions += 1;
        try {
            return await operation();
        } finally {
            this.admissions -= 1;
            if (sessionId) this.sessionMutations.delete(sessionId);
        }
    }

    private async changeProvider(change: (candidate: ProviderRouting) => void): Promise<void> {
        const pending = this.providerQueue.then(async () => {
            this.assertNoActiveTurns("providers/set or providers/disable");
            if (this.admissions > 0) throw acp.RequestError.invalidRequest(undefined, "Session configuration or lifecycle work is in progress; retry the provider change when it finishes");
            this.switching = true;
            const candidate = this.providers.copy();
            const attempted: SessionRuntime[] = [];
            const staged = new Map<SessionRuntime, {config: JsonObject; catalog: Session["catalog"]; model: Session["model"]}>();
            try {
                change(candidate);
                const catalog = await this.withCodex(() => this.codex.allModels(true));
                const modelProvider = await this.resolveModelProvider(candidate);
                // Codex cannot cold-resume a thread before its history storage exists.
                // Validate every session before detaching any subscription.
                for (const runtime of this.sessions.values()) {
                    try {
                        await this.codex.threadTurnsList({threadId: runtime.session.id, limit: 1, itemsView: "notLoaded"});
                    } catch (error) {
                        throw acp.RequestError.invalidRequest({sessionId: runtime.session.id, details: errorMessage(error)},
                            "Cannot reload this session's history for a provider change; close empty sessions and configure the provider before creating them, or retry after history is available");
                    }
                }
                for (const runtime of this.sessions.values()) {
                    const config = {...runtime.config};
                    const providers = candidate.threadConfig()["model_providers"];
                    if (providers === undefined) delete config["model_providers"];
                    else config["model_providers"] = providers;
                    const nextCatalog = candidate.catalog(catalog);
                    const requestedModel = candidate.active?.model
                        ?? (findModel(nextCatalog, runtime.session.model.model) ? runtime.session.model.model : null);
                    const selection = resolveModelSelection(nextCatalog, requestedModel, requestedModel === runtime.session.model.model ? runtime.session.model.effort : null);
                    attempted.push(runtime);
                    // A subscribed live thread treats resume as rejoin and ignores routing overrides.
                    await this.codex.threadUnsubscribe({threadId: runtime.session.id});
                    const thread = await this.withCodex(() => this.codex.threadResume({
                        threadId: runtime.session.id, cwd: runtime.session.cwd, config,
                        modelProvider, model: selection.model, excludeTurns: true,
                    }));
                    staged.set(runtime, {config, catalog: nextCatalog, model: resolveModelSelection(nextCatalog, candidate.active?.model ?? thread.model, thread.reasoningEffort)});
                }
                this.providers = candidate;
                for (const [runtime, next] of staged) {
                    runtime.config = next.config;
                    runtime.modelProvider = modelProvider;
                    runtime.session.catalog = next.catalog;
                    runtime.session.model = next.model;
                    runtime.stale = false;
                    // Notification delivery cannot roll back an already committed routing transaction.
                    void runtime.client.update({sessionUpdate: "config_option_update", configOptions: sessionConfigOptions(runtime.session), _meta: {codex: {routing: {stale: false}}}}).catch(error => logger.error("Provider config notification failed", error));
                }
            } catch (error) {
                if (attempted.length === 0 && error instanceof acp.RequestError) throw error;
                const staleSessions: string[] = [];
                for (const runtime of attempted) {
                    try {
                        await this.codex.threadUnsubscribe({threadId: runtime.session.id});
                        await this.codex.threadResume({threadId: runtime.session.id, cwd: runtime.session.cwd,
                            config: runtime.config, modelProvider: runtime.modelProvider, model: runtime.session.model.model, excludeTurns: true});
                    } catch (rollbackError) {
                        runtime.stale = true;
                        staleSessions.push(runtime.session.id);
                        logger.error("Provider rollback failed", rollbackError, {sessionId: runtime.session.id});
                        void runtime.client.update({sessionUpdate: "config_option_update", configOptions: sessionConfigOptions(runtime.session), _meta: {codex: {routing: {stale: true}}}}).catch(() => {});
                    }
                }
                throw acp.RequestError.internalError({staleSessions, attemptedSessions: attempted.map(runtime => runtime.session.id)},
                    `Provider change failed: ${errorMessage(error)}${staleSessions.length ? "; resume affected sessions or retry the provider change before prompting" : "; previous routing restored"}`);
            } finally { this.switching = false; }
        });
        this.providerQueue = pending.catch(() => {});
        await pending;
    }

    // ---- sessions ---------------------------------------------------------------

    async newSession(params: acp.NewSessionRequest, signal?: AbortSignal): Promise<acp.NewSessionResponse> {
        const runtime = await this.openSession({kind: "new", request: params}, signal);
        return {sessionId: runtime.session.id, configOptions: sessionConfigOptions(runtime.session)};
    }

    async resumeSession(params: acp.ResumeSessionRequest, signal?: AbortSignal): Promise<acp.ResumeSessionResponse> {
        const runtime = await this.openSession({kind: "resume", request: params}, signal);
        return {configOptions: sessionConfigOptions(runtime.session)};
    }

    async forkSession(params: acp.ForkSessionRequest, signal?: AbortSignal): Promise<acp.ForkSessionResponse> {
        const runtime = await this.openSession({kind: "fork", request: params}, signal);
        return {sessionId: runtime.session.id, configOptions: sessionConfigOptions(runtime.session)};
    }

    private async openSession(open: OpenRequest, signal?: AbortSignal): Promise<SessionRuntime> {
        if (signal?.aborted) throw acp.RequestError.requestCancelled(undefined, "Session opening was cancelled");
        const pending = this.admission(async () => {
            const runtime = await this.openSessionInternal(open, signal);
            if (signal?.aborted) {
                await this.closeRuntime(runtime.session.id);
                throw acp.RequestError.requestCancelled(undefined, "Session opening was cancelled");
            }
            return runtime;
        }, open.kind === "new" ? undefined : open.request.sessionId);
        try {
            return signal ? await abortable(pending, signal) : await pending;
        } catch (error) {
            if (signal?.aborted) throw acp.RequestError.requestCancelled(undefined, "Session opening was cancelled; any thread returned later will be unsubscribed");
            throw error;
        }
    }

    private assertUnsubscribeSettled(sessionId: string): void {
        if (this.pendingUnsubscribes.has(sessionId)) {
            throw acp.RequestError.invalidRequest({sessionId}, "A previous unsubscribe is still pending; retry after Codex responds or reconnect the agent");
        }
    }

    private async openSessionInternal(open: OpenRequest, signal?: AbortSignal): Promise<SessionRuntime> {
        const method = {new: "session/new", resume: "session/resume", fork: "session/fork"}[open.kind];
        const capabilities = this.requireInitialized(method);
        if (open.kind !== "new") this.assertUnsubscribeSettled(open.request.sessionId);
        const {request} = open;
        if (typeof request.cwd !== "string" || !path.isAbsolute(request.cwd)) {
            throw acp.RequestError.invalidParams({cwd: request.cwd}, "cwd must be an absolute path");
        }
        if (open.kind === "resume" && open.request.replayFrom != null && open.request.replayFrom.type !== "start") {
            throw acp.RequestError.invalidParams({replayFrom: open.request.replayFrom}, "Only replayFrom {type: \"start\"} is supported");
        }
        const seed = open.kind === "new" ? seedHistoryOf(open.request._meta) : [];
        const additionalDirectories = readAdditionalDirectories(request.cwd, request.additionalDirectories);
        if (open.kind === "resume" && this.sessions.has(open.request.sessionId)) {
            // A second open for a live session replaces it; close the old runtime first.
            await this.closeRuntime(open.request.sessionId);
            this.assertUnsubscribeSettled(open.request.sessionId);
        }
        const mcpServers = request.mcpServers ?? [];

        // A client-configured gateway carries its own credentials; only native OpenAI routing needs a login.
        let accountVersion = this.accountGeneration;
        const account = await this.withCodex(() => this.codex.accountRead({refreshToken: false}));
        if (this.providers.active === null && account.requiresOpenaiAuth && account.account === null) {
            throw acp.RequestError.authRequired(undefined, "Log in to Codex first (auth/login)");
        }
        const existingMcp = mcpServers.length > 0 ? await this.withCodex(() => this.configuredMcpServerNames(request.cwd)) : new Set<string>();
        const config = buildThreadConfig(this.providers.threadConfig(), request.cwd, additionalDirectories, mcpServers, existingMcp);
        const mcpStartupGeneration = this.codex.mcpStartupGeneration;
        const modelProvider = await this.withCodex(() => this.resolveModelProvider());

        const {thread, skills} = await this.withSkillsContext(request.cwd, additionalDirectories, async skills => ({skills, thread: await this.withCodex(async () => {
            if (signal?.aborted) throw acp.RequestError.requestCancelled(undefined, "Session opening was cancelled");
            switch (open.kind) {
                case "new":
                    return await this.codex.threadStart({config, cwd: request.cwd, modelProvider});
                case "resume":
                    // History is paged through thread/turns/list during replay; full hydration here is deprecated.
                    return await this.codex.threadResume({threadId: open.request.sessionId, config, cwd: request.cwd, modelProvider, excludeTurns: true});
                case "fork":
                    return await this.codex.threadFork({threadId: open.request.sessionId, config, cwd: request.cwd, modelProvider, excludeTurns: true});
            }
        })}));
        const sessionId = thread.thread.id;
        let removeCancellation = () => {};
        const openingCompletions = new Map<string, TurnCompletedNotification>();
        const openingStarts = new Set<string>();
        const stopObservingOpen = this.codex.observeNotifications(notification => {
            if (notification.method === "turn/completed" && notification.params.threadId === sessionId) {
                if (openingCompletions.size >= 32) openingCompletions.delete(openingCompletions.keys().next().value!);
                openingCompletions.set(notification.params.turn.id, notification.params);
            }
            if (notification.method === "turn/started" && notification.params.threadId === sessionId && this.sessions.has(sessionId)) {
                if (openingStarts.size >= 32) openingStarts.delete(openingStarts.values().next().value!);
                openingStarts.add(notification.params.turn.id);
            }
        });
        try {
            if (signal?.aborted) throw acp.RequestError.requestCancelled(undefined, "Session opening was cancelled");
            const codexCatalog = await this.withCodex(() => this.codex.allModels());
            let openedAccount = account.account;
            while (accountVersion !== this.accountGeneration) {
                accountVersion = this.accountGeneration;
                openedAccount = (await this.withCodex(() => this.codex.accountRead({refreshToken: false}))).account;
            }
            const gateway = this.providers.active;
            const catalog = this.providers.catalog(codexCatalog);
            const model = resolveModelSelection(catalog, gateway?.model ?? thread.model, thread.reasoningEffort);
            const session: Session = {
                id: sessionId,
                cwd: request.cwd,
                additionalDirectories,
                mcpServerNames: mcpServerNames(mcpServers).filter(name => !existingMcp.has(name)),
                catalog,
                model,
                mode: initialAgentMode(this.env),
                collaborationMode: DEFAULT_COLLABORATION_MODE,
                fastMode: thread.serviceTier === FAST_SERVICE_TIER,
                account: openedAccount,
                title: null,
                titleIsExplicit: false,
                activeTurn: null,
                lastUsage: null,
                contextWindow: null,
                closed: false,
            };
            const runtime = this.installRuntime(session, capabilities, config, thread.modelProvider);
            const cancelOpening = () => {
                runtime.session.closed = true;
                runtime.lifetime.abort();
                runtime.client.dispose();
            };
            signal?.addEventListener("abort", cancelOpening, {once: true});
            removeCancellation = () => signal?.removeEventListener("abort", cancelOpening);
            if (signal?.aborted) cancelOpening();
            const replay = open.kind === "fork" || (open.kind === "resume" && open.request.replayFrom?.type === "start");
            if (open.kind !== "new") {
                await this.replayHistory(runtime, replay, thread.thread);
            } else {
                if (seed.length > 0) {
                    await this.withCodex(() => this.codex.threadInjectItems({threadId: sessionId, items: seed.map(seedItem)}));
                }
            }
            if (thread.thread.status.type === "active" && runtime.session.activeTurn === null) {
                const latest = await this.withCodex(() => this.codex.threadTurnsList({threadId: session.id, limit: 1, sortDirection: "desc", itemsView: "full"}));
                const active = latest.data.find(turn => turn.status === "inProgress");
                if (active && !(openingStarts.has(active.id) && openingCompletions.has(active.id))) {
                    const completed = openingCompletions.get(active.id);
                    this.observeForeignTurn(runtime, active.id, completed ? Promise.resolve(completed) : undefined, active.items);
                }
            }
            if (mcpServers.length > 0) void this.reportMcpStartup(runtime, mcpStartupGeneration);
            void this.publishAvailableCommands(runtime, skills);
            return runtime;
        } catch (error) {
            // The thread is loaded and subscribed on the Codex side; do not leak it.
            const runtime = this.sessions.get(sessionId);
            if (runtime) {
                runtime.session.closed = true;
                runtime.lifetime.abort();
                runtime.bridge.dispose();
                runtime.client.dispose();
            }
            this.sessions.delete(sessionId);
            this.codex.detachThread(sessionId);
            await within(this.unsubscribeThread(sessionId), this.closeGraceMs).catch(() => {});
            throw error;
        } finally {
            removeCancellation();
            stopObservingOpen();
        }
    }

    private installRuntime(session: Session, capabilities: ClientCapabilitySet, config: JsonObject, modelProvider: string | null): SessionRuntime {
        const client = new ClientSession(session.id, this.link, capabilities);
        const bridge = new EventBridge(client, session);
        const turnContext = new TurnContext(session.id);
        const signal = () => {
            const turn = session.activeTurn;
            return AbortSignal.any([this.codex.disconnectSignal, ...(turn ? [turn.abort.signal, turn.stop.signal] : [])]);
        };
        const approval = new CodexApprovalHandler(client, turnContext, signal);
        const elicitation = new CodexElicitationHandler(client, turnContext, signal);
        const runtime: SessionRuntime = {config, modelProvider, stale: false, session, client, bridge, turnContext, elicitation, lifetime: new AbortController(), queue: Promise.resolve()};
        // Frames already queued (e.g. the tool call under review) must reach the client before its prompt.
        const drained = <P, T>(operation: (params: P) => Promise<T>) => async (params: P): Promise<T> => {
            await abortable(this.drain(runtime), this.codex.disconnectSignal);
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
        if (runtime.lifetime.signal.aborted) return;
        if (notification.method === "turn/started" && runtime.session.activeTurn === null) {
            this.observeForeignTurn(runtime, notification.params.turn.id);
        }
        const turn = runtime.session.activeTurn;
        if (notification.method.startsWith("item/") && "turnId" in notification.params && typeof notification.params.turnId === "string") {
            // A start response may trail its first items; filter only once ownership is known.
            if (!turn || (turn.turnId !== null && notification.params.turnId !== turn.turnId)) return;
        }
        if (turn && notification.method === "turn/completed") this.completedTurns.set(turn, notification.params.turn.id);
        if (runtime.lifetime.signal.aborted) return;
        const run = async () => {
            if (runtime.lifetime.signal.aborted) return;
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

    private observeForeignTurn(runtime: SessionRuntime, turnId: string, completion?: Promise<TurnCompletedNotification>, items: readonly ThreadItem[] = []): void {
        if (runtime.session.activeTurn || runtime.session.closed) return;
        const turn = createActiveTurn(runtime.session.id);
        runtime.session.activeTurn = turn;
        this.turnStarted(runtime, turn, turnId, runtime.session.id);
        runtime.client.reportRunning();
        const completed = completion ?? this.codex.awaitTurnCompleted(runtime.session.id, turnId, turn.stop.signal);
        void this.runPrompt(runtime, turn, {sessionId: runtime.session.id, prompt: []}, completed, items);
    }

    private async drain(runtime: SessionRuntime): Promise<void> {
        let current: Promise<void>;
        do {
            current = runtime.queue;
            await abortable(current, runtime.client.signal);
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
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
            const page: {data: Turn[]; nextCursor: string | null} = await this.turnPage(session.id, cursor);
            await publishTitle(page.data);
            await client.updateAll(historyUpdates(page.data));
            cursor = page.nextCursor;
            if (cursor !== null) {
                if (cursors.has(cursor)) throw acp.RequestError.internalError({sessionId: session.id}, "Codex history pagination repeated a cursor; retry after restarting Codex");
                cursors.add(cursor);
            }
        } while (cursor !== null && !session.closed);
        await publishTitle([]);
    }

    private async turnPage(threadId: string, cursor: string | null): Promise<{data: Turn[]; nextCursor: string | null}> {
        const page = await this.withCodex(() => this.codex.threadTurnsList({threadId, cursor, limit: HISTORY_PAGE_SIZE, sortDirection: "asc", itemsView: "full"}));
        return {data: page.data, nextCursor: page.nextCursor};
    }

    private async reportMcpStartup(runtime: SessionRuntime, afterGeneration: number): Promise<void> {
        try {
            const result = await this.codex.awaitMcpStartup(runtime.session.mcpServerNames, afterGeneration, runtime.lifetime.signal, runtime.session.id);
            if (runtime.session.closed) return;
            for (const failure of result.failed) {
                await runtime.client.update(mcpStartupFailed(failure.server, `MCP server "${failure.server}" failed to start: ${failure.error}`));
            }
            for (const server of result.cancelled) {
                await runtime.client.update(mcpStartupFailed(server, `MCP server "${server}" startup was cancelled.`));
            }
        } catch (error) {
            if (runtime.lifetime.signal.aborted) return;
            logger.error("MCP startup reporting failed", error, {sessionId: runtime.session.id});
        }
    }

    private async publishAvailableCommands(runtime: SessionRuntime, snapshot?: Awaited<ReturnType<AppServerClient["skillsList"]>>): Promise<void> {
        try {
            const skills = snapshot ?? await this.codex.skillsList({cwds: [runtime.session.cwd, ...runtime.session.additionalDirectories]});
            if (runtime.session.closed) return;
            await runtime.client.update({sessionUpdate: "available_commands_update", availableCommands: availableCommands(skills.data)});
            this.publishedSkills.set(runtime, skills);
        } catch (error) {
            logger.error("publishing available commands failed", error, {sessionId: runtime.session.id});
        }
    }

    async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        this.requireInitialized("session/list");
        const cwd = params.cwd?.trim() || null;
        const archived = archivedFilter(params._meta);
        const response = await this.withCodex(() => this.codex.threadList({
            cursor: params.cursor ?? null,
            ...(cwd ? {cwd} : {}),
            sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
            // Codex lists non-archived threads by default; the archive is a separate page.
            ...(archived ? {archived: true} : {}),
        }));
        return {
            sessions: response.data.map(thread => ({
                sessionId: thread.id,
                cwd: thread.cwd,
                title: thread.name?.trim() || thread.preview.trim() || null,
                updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
                _meta: {codex: {archived}},
            })),
            nextCursor: response.nextCursor,
        };
    }

    async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
        return await this.admission(() => this.closeSessionInternal(params), params.sessionId);
    }

    private async closeSessionInternal(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
        this.requireInitialized("session/close");
        return await this.closeRuntime(params.sessionId);
    }

    async deleteSession(params: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
        return await this.admission(() => this.deleteSessionInternal(params), params.sessionId);
    }

    private async deleteSessionInternal(params: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
        this.requireInitialized("session/delete");
        await this.closeRuntime(params.sessionId);
        // Real deletion, like Codex desktop's Delete; hiding is `_codex/session_archive`.
        await this.withCodex(() => this.codex.threadDelete({threadId: params.sessionId}));
        return {};
    }

    async archiveSession(params: SessionIdParams): Promise<Record<string, never>> {
        return await this.admission(() => this.archiveSessionInternal(params), params.sessionId);
    }

    private async archiveSessionInternal(params: SessionIdParams): Promise<Record<string, never>> {
        this.requireInitialized("_codex/session_archive");
        await this.closeRuntime(params.sessionId);
        await this.withCodex(() => this.codex.threadArchive({threadId: params.sessionId}));
        return {};
    }

    async unarchiveSession(params: SessionIdParams): Promise<Record<string, never>> {
        return await this.admission(() => this.unarchiveSessionInternal(params), params.sessionId);
    }

    private async unarchiveSessionInternal(params: SessionIdParams): Promise<Record<string, never>> {
        this.requireInitialized("_codex/session_unarchive");
        await this.withCodex(() => this.codex.threadUnarchive({threadId: params.sessionId}));
        return {};
    }

    // ---- skills and plugins ---------------------------------------------------------

    async skillsList(params: SkillsListParams): Promise<SkillsListResponse> {
        this.requireInitialized("_codex/skills_list");
        return await this.withCodex(() => this.codex.skillsList(params));
    }

    async skillsConfigWrite(params: SkillsConfigWriteParams): Promise<SkillsConfigWriteResponse> {
        this.requireInitialized("_codex/skills_config_write");
        const response = await this.withCodex(() => this.codex.skillsConfigWrite(params));
        this.notifySkillsChanged();
        return response;
    }

    async pluginList(params: PluginListParams): Promise<PluginListResponse> {
        this.requireInitialized("_codex/plugin_list");
        return await this.withCodex(() => this.codex.pluginList(params));
    }

    async pluginInstalled(params: PluginInstalledParams): Promise<PluginInstalledResponse> {
        this.requireInitialized("_codex/plugin_installed");
        return await this.withCodex(() => this.codex.pluginInstalled(params));
    }

    async pluginInstall(params: PluginInstallParams): Promise<PluginInstallResponse> {
        this.requireInitialized("_codex/plugin_install");
        const response = await this.withCodex(() => this.codex.pluginInstall(params));
        this.notifySkillsChanged();
        return response;
    }

    async pluginUninstall(params: PluginUninstallParams): Promise<Record<string, never>> {
        this.requireInitialized("_codex/plugin_uninstall");
        await this.withCodex(() => this.codex.pluginUninstall(params));
        this.notifySkillsChanged();
        return {};
    }

    async pluginRead(params: PluginReadParams): Promise<PluginReadResponse> {
        this.requireInitialized("_codex/plugin_read");
        return await this.withCodex(() => this.codex.pluginRead(params));
    }

    async marketplaceAdd(params: MarketplaceAddParams): Promise<MarketplaceAddResponse> {
        this.requireInitialized("_codex/marketplace_add");
        const response = await this.withCodex(() => this.codex.marketplaceAdd(params));
        this.notifySkillsChanged();
        return response;
    }

    async marketplaceRemove(params: MarketplaceRemoveParams): Promise<Record<string, never>> {
        this.requireInitialized("_codex/marketplace_remove");
        await this.withCodex(() => this.codex.marketplaceRemove(params));
        this.notifySkillsChanged();
        return {};
    }

    async marketplaceUpgrade(params: MarketplaceUpgradeParams): Promise<MarketplaceUpgradeResponse> {
        this.requireInitialized("_codex/marketplace_upgrade");
        const response = await this.withCodex(() => this.codex.marketplaceUpgrade(params));
        this.notifySkillsChanged();
        return response;
    }

    /**
     * One signal for both catalogs: Codex's `skills/changed` and every catalog mutation made
     * through this adapter. Plugins ship skills, so a plugin change is a skills change too.
     */
    private notifySkillsChanged(): void {
        void this.link.notify("_codex/skills_changed", {}).catch(error => logger.error("skills change notification failed", error));
    }

    private async closeRuntime(sessionId: string): Promise<acp.CloseSessionResponse> {
        const deadline = performance.now() + this.closeGraceMs;
        const runtime = this.sessions.get(sessionId);
        if (!runtime) return {};
        runtime.session.closed = true;
        runtime.lifetime.abort();
        const turn = runtime.session.activeTurn;
        if (turn) {
            void this.interruptTurn(runtime, turn);
            // Reserve half the total budget for unsubscribe, even if interruption stalls.
            await within(turn.finished, Math.max(0, this.closeGraceMs / 2));
            if (runtime.session.activeTurn === turn) {
                // One best-effort terminal write; disposal releases any backpressured write.
                await within(this.reportIdle(runtime, turn, "cancelled", {usage: usageOf(runtime.session)}), Math.max(0, (deadline - performance.now()) / 2)).catch(() => {});
            }
            turn.stop.abort();
        }
        if (this.sessions.get(sessionId) === runtime) this.sessions.delete(sessionId);
        this.codex.detachThread(sessionId);
        runtime.client.dispose();
        runtime.bridge.dispose();
        if (turn) {
            turn.resolveStarted(null);
            runtime.session.activeTurn = null;
            turn.resolveFinished();
        }
        const unsubscribe = this.unsubscribeThread(sessionId);
        let remoteUnsubscribe: "confirmed" | "timed_out" | "failed" = "confirmed";
        try {
            if (!await within(unsubscribe, Math.max(0, deadline - performance.now()))) {
                remoteUnsubscribe = "timed_out";
            }
        } catch (error) {
            remoteUnsubscribe = "failed";
            logger.error("thread/unsubscribe failed", error, {sessionId});
        }
        if (remoteUnsubscribe !== "confirmed") logger.log("session close detached locally", {sessionId, remoteUnsubscribe});
        return {_meta: {codex: {close: {attempted: true, localDetached: true, remoteUnsubscribe}}}};
    }

    private unsubscribeThread(sessionId: string): Promise<unknown> {
        const unsubscribe = this.codex.threadUnsubscribe({threadId: sessionId});
        this.pendingUnsubscribes.set(sessionId, unsubscribe);
        const release = () => {
            if (this.pendingUnsubscribes.get(sessionId) === unsubscribe) this.pendingUnsubscribes.delete(sessionId);
        };
        void unsubscribe.then(release, release);
        return unsubscribe;
    }

    async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
        return await this.admission(() => this.setSessionConfigOptionInternal(params), params.sessionId);
    }

    private async setSessionConfigOptionInternal(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
        const runtime = this.runtime(params.sessionId, "session/set_config_option");
        await this.withCodex(() => applyConfigOption(runtime.session, this.codex, params));
        const configOptions = sessionConfigOptions(runtime.session);
        await runtime.client.update({sessionUpdate: "config_option_update", configOptions});
        return {configOptions};
    }

    private runtime(sessionId: string, method: string): SessionRuntime {
        this.requireInitialized(method);
        const runtime = this.sessions.get(sessionId);
        if (!runtime || runtime.session.closed) throw acp.RequestError.invalidParams({sessionId}, `Unknown session "${sessionId}" (missing or closed); create or resume it first`);
        return runtime;
    }

    // ---- prompts ------------------------------------------------------------------

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
        return await this.promptInternal(params);
    }

    private async promptInternal(params: acp.PromptRequest, allowReentry = false): Promise<acp.PromptResponse> {
        this.assertRoutingAvailable();
        if (!allowReentry && this.sessionMutations.has(params.sessionId)) throw acp.RequestError.invalidRequest({sessionId: params.sessionId}, "Session lifecycle or configuration work is in progress; retry when it finishes");
        const runtime = this.runtime(params.sessionId, "session/prompt");
        if (runtime.stale) throw acp.RequestError.invalidRequest({sessionId: params.sessionId, _meta: {codex: {routing: {stale: true}}}}, "Session routing is stale; resume the session or successfully change providers before prompting");
        if (!Array.isArray(params.prompt) || params.prompt.length === 0) {
            throw acp.RequestError.invalidParams(undefined, "prompt must contain at least one content block");
        }
        const {session} = runtime;
        const model = findModel(session.catalog, session.model.model);
        if (!modelSupportsImages(model) && params.prompt.some(block => block.type === "image")) {
            throw acp.RequestError.invalidParams({model: session.model.model}, "The current model does not support image input");
        }
        if (session.activeTurn) {
            return await this.steerActiveTurn(runtime, session.activeTurn, params);
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
            // Retry as a new prompt only after a matching completion proves the steer lost the race.
            if (this.completedTurns.get(turn) === turnId || runtime.session.activeTurn !== turn) {
                await turn.finished;
                return await this.promptInternal(params, true);
            }
            throw acp.RequestError.invalidRequest({sessionId: params.sessionId, turnId}, `Could not steer the running turn: ${errorMessage(error)}`);
        }
    }

    private async runPrompt(runtime: SessionRuntime, turn: ActiveTurn, params: acp.PromptRequest, observed?: Promise<TurnCompletedNotification>, items: readonly ThreadItem[] = []): Promise<void> {
        const {session, bridge} = runtime;
        bridge.beginTurn();
        if (items.length) runtime.queue = runtime.queue.then(() => bridge.restore(items));
        try {
            const command = parseCommand(params.prompt);
            const outcome = command ? resolveCommand(command, session) : {kind: "prompt" as const};
            let completed = await abortable(observed ?? this.executePrompt(runtime, turn, command, outcome, params), turn.stop.signal);
            await this.drain(runtime);
            await bridge.flush();

            if (completed?.turn.status === "completed" && !turn.abort.signal.aborted && !this.exitHandled) {
                completed = await abortable(this.maybeImplementPlan(runtime, turn, completed), turn.stop.signal);
            }
            if (completed?.turn.status === "interrupted" || turn.abort.signal.aborted) {
                await this.reportIdle(runtime, turn, "cancelled", {usage: usageOf(session)});
                return;
            }
            if (completed?.turn.status === "failed") {
                await this.reportTurnFailure(runtime, turn, completed.turn.error ?? bridge.takeError() ?? {message: "Turn failed", codexErrorInfo: null, additionalDetails: null, misalignment: null});
                return;
            }
            const pendingError = bridge.takeError();
            if (pendingError) {
                await this.reportTurnFailure(runtime, turn, pendingError);
                return;
            }
            await this.publishFallbackTitle(runtime, promptTitle(params.prompt));
            await this.reportIdle(runtime, turn, "end_turn", {usage: usageOf(session)});
        } catch (error) {
            if (this.terminalTurns.has(turn)) {
                logger.error("Terminal update failed", error, {sessionId: session.id});
                return;
            }
            if (turn.stop.signal.aborted && session.closed) return;
            if (turn.abort.signal.aborted || session.closed) {
                await this.reportIdle(runtime, turn, "cancelled", {usage: usageOf(session)}).catch(() => {});
                return;
            }
            logger.error("prompt failed", error, {sessionId: session.id});
            await this.reportTurnFailure(runtime, turn, this.failureOf(error)).catch(() => {});
        } finally {
            turn.resolveStarted(null);
            if (session.activeTurn === turn) session.activeTurn = null;
            turn.resolveFinished();
        }
    }

    private async executePrompt(runtime: SessionRuntime, turn: ActiveTurn, command: ReturnType<typeof parseCommand>, outcome: ReturnType<typeof resolveCommand>, params: acp.PromptRequest): Promise<TurnCompletedNotification | null> {
        const {session, client} = runtime;
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
                    this.turnStarted(runtime, turn, turnId, threadId);
                }, turn.stop.signal));
                break;
            case "logout":
                await this.withCodex(() => logout(this.codex));
                await this.refreshAccounts();
                await client.update(agentMessage(`command:logout:${Date.now()}`, "Logged out of the Codex account."));
                break;
        }
        return completed;
    }

    private async runCodexTurn(runtime: SessionRuntime, turn: ActiveTurn, prompt: readonly acp.ContentBlock[]): Promise<TurnCompletedNotification> {
        const {session} = runtime;
        const model = findModel(session.catalog, session.model.model);
        const disableSummary = session.account?.type === "apiKey" || modelLacksReasoning(model);
        let startSent = false;
        const beforeStart = new AbortController();
        const cancelBeforeStart = () => {if (!startSent) beforeStart.abort(turn.abort.signal.reason);};
        turn.abort.signal.addEventListener("abort", cancelBeforeStart, {once: true});
        if (turn.abort.signal.aborted) cancelBeforeStart();
        try {
            const result = await abortable(this.withSkillsContext(session.cwd, session.additionalDirectories, async skills => {
                if (this.publishedSkills.get(runtime) !== skills) void this.publishAvailableCommands(runtime, skills);
                if (turn.abort.signal.aborted || turn.stop.signal.aborted) return {completed: Promise.resolve(interruptedTurn(session.id))};
                startSent = true;
                const completed = this.withCodex(() => this.codex.runTurn({
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
                    this.turnStarted(runtime, turn, turnId, session.id);
                }, turn.stop.signal));
                await Promise.race([turn.started, completed]);
                return {completed};
            }), beforeStart.signal);
            return await result.completed;
        } finally {
            turn.abort.signal.removeEventListener("abort", cancelBeforeStart);
        }
    }

    private async runCompaction(runtime: SessionRuntime, turn: ActiveTurn): Promise<void> {
        const threadId = runtime.session.id;
        turn.resolveStarted(null);
        const pending = new AbortController();
        const signal = AbortSignal.any([pending.signal, turn.abort.signal]);
        const completed = Promise.race([
            this.codex.awaitNotification("item/completed", params => params.threadId === threadId && params.item.type === "contextCompaction", signal),
            this.codex.awaitNotification("thread/compacted", params => params.threadId === threadId, signal),
        ]);
        void completed.catch(() => {});
        try {
            signal.throwIfAborted();
            await abortable(this.withCodex(() => this.codex.threadCompactStart({threadId})), signal);
            await completed;
        } finally {
            // Codex versions report either event; dispose the losing waiter as well.
            pending.abort();
        }
    }

    /** In plan collaboration mode a finished plan asks the user whether to implement it now. */
    private async maybeImplementPlan(runtime: SessionRuntime, turn: ActiveTurn, completed: TurnCompletedNotification): Promise<TurnCompletedNotification> {
        const plan = runtime.bridge.takeCompletedPlan();
        if (!plan || runtime.session.collaborationMode !== PLAN_COLLABORATION_MODE) return completed;
        this.completedTurns.delete(turn);
        const signal = AbortSignal.any([turn.abort.signal, turn.stop.signal]);
        const approved = await this.requestPlanApproval(runtime, plan, signal);
        if (!approved || signal.aborted) return completed;
        await this.setSessionConfigOption({sessionId: runtime.session.id, configId: "collaboration_mode", type: "id", value: DEFAULT_COLLABORATION_MODE});
        runtime.bridge.beginTurn();
        turn.resetStarted();
        const implementation = await this.runCodexTurn(runtime, turn, [{type: "text", text: "Implement the approved plan."}]);
        await this.drain(runtime);
        await runtime.bridge.flush();
        return implementation;
    }

    private async requestPlanApproval(runtime: SessionRuntime, plan: CompletedPlan, signal: AbortSignal): Promise<boolean> {
        const toolCallId = `plan-review:${plan.itemId}`;
        const toolCall = {toolCallId, name: ToolName.PlanReview, title: "Implement this plan?", kind: "switch_mode" as const, status: "pending" as const, rawInput: {plan: plan.text}};
        try {
            await runtime.client.update({sessionUpdate: "tool_call_update", ...toolCall});
            const response = await runtime.client.requestPermission({
                title: "Implement this plan?",
                subject: {type: "tool_call", toolCall},
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
            await runtime.client.update({sessionUpdate: "tool_call_update", toolCallId, status: signal.aborted ? "cancelled" : "failed"}).catch(() => {});
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

    private async reportIdle(runtime: SessionRuntime, turn: ActiveTurn, reason: acp.StopReason, extra?: Parameters<ClientSession["reportIdle"]>[1]): Promise<void> {
        if (this.terminalTurns.has(turn)) return;
        this.terminalTurns.add(turn);
        await runtime.bridge.finishOpenToolCalls(reason === "cancelled" ? "cancelled" : reason === "end_turn" ? "completed" : "failed");
        // The client may send its next prompt as soon as it receives idle.
        if (runtime.session.activeTurn === turn) runtime.session.activeTurn = null;
        await runtime.client.reportIdle(reason, extra);
    }

    private async reportTurnFailure(runtime: SessionRuntime, turn: ActiveTurn, error: TurnError): Promise<void> {
        const {stopReason, ...classification} = classifyTurnError(error.codexErrorInfo);
        const message = error.additionalDetails ? `${error.message}\n\n${error.additionalDetails}` : error.message;
        await runtime.client.update({
            sessionUpdate: "agent_message_chunk",
            messageId: `codex-error:${runtime.session.id}:${Date.now()}`,
            content: {type: "text", text: message},
            _meta: {codex: {error: {...classification, message: error.message, codexErrorInfo: error.codexErrorInfo, additionalDetails: error.additionalDetails}}},
        });
        await this.reportIdle(runtime, turn, stopReason, {
            usage: usageOf(runtime.session),
            _meta: {codex: {error: {...classification, message: error.message, codexErrorInfo: error.codexErrorInfo}}},
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
        await this.sendInterrupt(runtime, turn, turnId);
    }

    private sendInterrupt(runtime: SessionRuntime, turn: ActiveTurn, turnId: string): Promise<void> {
        const key = `${turn.threadId}:${turnId}`;
        let pending = turn.interrupts.get(key);
        if (!pending) {
            pending = this.codex.turnInterrupt({threadId: turn.threadId, turnId}).then(() => {}, error => {
                turn.interrupts.delete(key);
                logger.error("turn/interrupt failed", error, {sessionId: runtime.session.id, turnId});
            });
            turn.interrupts.set(key, pending);
        }
        return pending;
    }

    private turnStarted(runtime: SessionRuntime, turn: ActiveTurn, turnId: string, threadId: string): void {
        turn.turnId = turnId;
        turn.threadId = threadId;
        turn.resolveStarted(turnId);
        // A close may have already ended local waiting before turn/start finally returns.
        if (turn.abort.signal.aborted) void this.sendInterrupt(runtime, turn, turnId);
    }

    // ---- helpers ------------------------------------------------------------------

    private withSkillsContext<T>(cwd: string, additionalDirectories: readonly string[], operation: (skills: Awaited<ReturnType<AppServerClient["skillsList"]>>) => Promise<T>): Promise<T> {
        const run = async () => {
            const roots = additionalDirectories.map(root => path.join(root, ".agents", "skills"));
            if (roots.length !== this.skillRoots.length || roots.some((root, index) => root !== this.skillRoots[index])) {
                this.changingSkillRoots = true;
                try {
                    await this.codex.skillsExtraRootsSet({extraRoots: roots});
                } finally {
                    this.changingSkillRoots = false;
                }
                this.skillRoots = roots;
                this.skillSnapshots.clear();
            }
            const skills = await this.loadSkills(cwd, additionalDirectories);
            return await operation(skills);
        };
        // Extra roots are process-global. Hold the context through thread/turn start, not inference.
        const result = this.skillsQueue.then(run, run);
        this.skillsQueue = result.then(() => {}, () => {});
        return result;
    }

    private async loadSkills(cwd: string, additionalDirectories: readonly string[]) {
        const key = JSON.stringify([cwd, ...additionalDirectories]);
        let skills = this.skillSnapshots.get(key);
        if (!skills) {
            const generation = this.skillsGeneration;
            skills = await this.withCodex(() => this.codex.skillsList({cwds: [cwd, ...additionalDirectories], forceReload: true}));
            if (generation === this.skillsGeneration) {
                if (this.skillSnapshots.size >= 64) this.skillSnapshots.delete(this.skillSnapshots.keys().next().value!);
                this.skillSnapshots.set(key, skills);
            }
        }
        return skills;
    }

    private async refreshAvailableCommands(runtime: SessionRuntime): Promise<void> {
        const run = async () => {
            const roots = runtime.session.additionalDirectories.map(root => path.join(root, ".agents", "skills"));
            // A change notification must never itself switch this process-global setting.
            if (runtime.session.closed || roots.length !== this.skillRoots.length || roots.some((root, i) => root !== this.skillRoots[i])) return undefined;
            return await this.loadSkills(runtime.session.cwd, runtime.session.additionalDirectories);
        };
        const pending = this.skillsQueue.then(run, run);
        this.skillsQueue = pending.then(() => {}, () => {});
        try {
            const skills = await pending;
            if (skills && !runtime.session.closed) await this.publishAvailableCommands(runtime, skills);
        } catch (error) {
            logger.error("refreshing available commands failed", error, {sessionId: runtime.session.id});
        }
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

    private async resolveModelProvider(routing: ProviderRouting = this.providers): Promise<string> {
        const routed = routing.modelProvider();
        if (routed) return routed;
        const config = await this.codex.configRead({includeLayers: false});
        const provider = config.config["model_provider"];
        return typeof provider === "string" && provider.length > 0 ? provider : OPENAI_PROVIDER_ID;
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

    /** A thrown error as a Codex-shaped turn error; a lost connection carries the process's stderr tail. */
    private failureOf(error: unknown): TurnError {
        const details = error instanceof Error ? (error as {additionalDetails?: unknown}).additionalDetails : undefined;
        return {
            message: this.describeFailure(error),
            codexErrorInfo: null,
            additionalDetails: typeof details === "string" && details.length > 0 ? details : null,
            misalignment: null,
        };
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
            if (!turn || this.completedTurns.get(turn) === turn.turnId) continue;
            const stderr = this.process?.recentStderr() || null;
            // The stop abort wins the race against the synthesized completion below, so the
            // stderr tail rides on the abort reason too; it is the only diagnostic left.
            turn.stop.abort(Object.assign(new Error("Connection to Codex was lost"), {additionalDetails: stderr}));
            turn.resolveStarted(null);
            if (turn.turnId) {
                this.codex.failTurn(turn.threadId, turn.turnId, {
                    message: "Connection to Codex was lost",
                    codexErrorInfo: null,
                    additionalDetails: stderr,
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

export interface SessionIdParams {
    sessionId: string;
}

/**
 * `_codex/skills_*`, `_codex/plugin_*`, `_codex/marketplace_*` params are Codex v2 shapes
 * passed through verbatim; only the envelope is checked here, Codex validates the fields.
 */
export function objectParams<T extends object>(): (raw: unknown) => T {
    return raw => {
        if (raw === undefined || raw === null) return {} as T;
        if (typeof raw !== "object" || Array.isArray(raw)) {
            throw acp.RequestError.invalidParams({params: raw}, "expected a params object");
        }
        return raw as T;
    };
}

/** `_codex/session_archive` / `_codex/session_unarchive` params: `{sessionId}`. */
export function parseSessionIdParams(raw: unknown): SessionIdParams {
    const sessionId = (raw as {sessionId?: unknown} | null)?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw acp.RequestError.invalidParams({params: raw}, "expected {sessionId: string}");
    }
    return {sessionId};
}

/** `session/list` `_meta.codex.archived`: true pages the archive, anything else the live list. */
function archivedFilter(meta: acp.ListSessionsRequest["_meta"]): boolean {
    const codex = (meta as {codex?: {archived?: unknown}} | null | undefined)?.codex;
    return codex?.archived === true;
}

export interface SeedMessage {
    role: "user" | "assistant";
    text: string;
}

/** `session/new` `_meta.codex.seedHistory`: prior conversation to inject as model-visible history. */
function seedHistoryOf(meta: acp.NewSessionRequest["_meta"]): SeedMessage[] {
    const raw = (meta as {codex?: {seedHistory?: unknown}} | null | undefined)?.codex?.seedHistory;
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw acp.RequestError.invalidParams({seedHistory: raw}, "seedHistory must be an array of {role, text}");
    return raw.map((entry, index) => {
        const role = (entry as {role?: unknown})?.role;
        const text = (entry as {text?: unknown})?.text;
        if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
            throw acp.RequestError.invalidParams({index, entry}, "seedHistory entries are {role: \"user\" | \"assistant\", text: string}");
        }
        return {role, text};
    });
}

/** Responses API message item for thread/inject_items. */
function seedItem(message: SeedMessage): JsonValue {
    return {
        type: "message",
        role: message.role,
        content: [{type: message.role === "user" ? "input_text" : "output_text", text: message.text}],
    };
}

/** A single local deadline; late settlement remains observed after timeout. */
async function within(operation: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation.then(() => true),
            new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); }),
        ]);
    } finally { clearTimeout(timer); }
}
