import {RequestType, type MessageConnection} from "vscode-jsonrpc/node";
import type {ClientRequest, FuzzyFileSearchParams, FuzzyFileSearchResponse, InitializeParams, InitializeResponse, ServerNotification} from "../app-server";
import type {
    CancelLoginAccountParams,
    CancelLoginAccountResponse,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    ConfigReadParams,
    ConfigReadResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    GetAccountParams,
    GetAccountRateLimitsResponse,
    GetAccountResponse,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
    LoginAccountParams,
    LoginAccountResponse,
    LogoutAccountResponse,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    McpServerStartupState,
    Model,
    ModelListParams,
    ModelListResponse,
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
    ReviewStartParams,
    ReviewStartResponse,
    SkillsExtraRootsSetParams,
    MarketplaceAddParams,
    MarketplaceAddResponse,
    MarketplaceRemoveParams,
    MarketplaceRemoveResponse,
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
    PluginUninstallResponse,
    SkillsConfigWriteParams,
    SkillsConfigWriteResponse,
    SkillsListParams,
    SkillsListResponse,
    ThreadArchiveParams,
    ThreadArchiveResponse,
    ThreadDeleteParams,
    ThreadDeleteResponse,
    ThreadCompactStartParams,
    ThreadCompactStartResponse,
    ThreadForkParams,
    ThreadForkResponse,
    ThreadInjectItemsParams,
    ThreadInjectItemsResponse,
    ThreadListParams,
    ThreadListResponse,
    ThreadReadParams,
    ThreadSetNameParams,
    ThreadSetNameResponse,
    ThreadReadResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    ThreadStartParams,
    ThreadStartResponse,
    ThreadTurnsListParams,
    ThreadTurnsListResponse,
    ThreadUnsubscribeParams,
    ThreadUnarchiveParams,
    ThreadUnarchiveResponse,
    ThreadUnsubscribeResponse,
    ToolRequestUserInputParams,
    ToolRequestUserInputResponse,
    TurnCompletedNotification,
    TurnError,
    TurnInterruptParams,
    TurnInterruptResponse,
    TurnStartParams,
    TurnStartResponse,
    TurnSteerParams,
    TurnSteerResponse,
} from "../app-server/v2";
import type {ModeKind} from "../app-server/ModeKind";
import {logger} from "../util/logger";
import {abortable} from "../util/abort";

export interface ApprovalHandler {
    handleCommandExecution(params: CommandExecutionRequestApprovalParams): Promise<CommandExecutionRequestApprovalResponse>;
    handleFileChange(params: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse>;
    handlePermissionsRequest(params: PermissionsRequestApprovalParams): Promise<PermissionsRequestApprovalResponse>;
}

export interface ElicitationHandler {
    handleElicitation(params: McpServerElicitationRequestParams): Promise<McpServerElicitationRequestResponse>;
    handleUserInput(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse>;
}

export type McpStartupResult = {
    ready: string[];
    failed: Array<{server: string; error: string}>;
    cancelled: string[];
};

export interface ThreadSettingsUpdateParams {
    threadId: string;
    collaborationMode: {
        mode: ModeKind;
        settings: {
            model: string;
            reasoning_effort: string | null;
            developer_instructions: string | null;
        };
    };
}

export type NotificationHandler = (notification: ServerNotification) => void;
export type NotificationParams<M extends ServerNotification["method"]> = Extract<ServerNotification, {method: M}>["params"];

const CommandExecutionApprovalRequest = new RequestType<CommandExecutionRequestApprovalParams, CommandExecutionRequestApprovalResponse, void>("item/commandExecution/requestApproval");
const FileChangeApprovalRequest = new RequestType<FileChangeRequestApprovalParams, FileChangeRequestApprovalResponse, void>("item/fileChange/requestApproval");
const PermissionsApprovalRequest = new RequestType<PermissionsRequestApprovalParams, PermissionsRequestApprovalResponse, void>("item/permissions/requestApproval");
const McpServerElicitationRequest = new RequestType<McpServerElicitationRequestParams, McpServerElicitationRequestResponse, void>("mcpServer/elicitation/request");
const ToolRequestUserInputRequest = new RequestType<ToolRequestUserInputParams, ToolRequestUserInputResponse, void>("item/tool/requestUserInput");

type CodexRequest = ClientRequest extends infer R ? (R extends {method: string} ? Omit<R, "id"> : never) : never;

type McpStartupSnapshot = {status: McpServerStartupState; error: string | null; version: number};
type NotificationWaiter = {method: string; matches: (params: unknown) => boolean; resolve: (params: unknown) => void};
type McpStartupWaiter = {serverNames: string[]; afterVersion: number; threadId: string | null; resolve: (result: McpStartupResult) => void};

/**
 * Typed client over the Codex app-server JSON-RPC API (v2 surface only).
 *
 * Notifications are routed per thread; server-initiated approval and elicitation
 * requests are dispatched to the handler registered for their thread and fail
 * closed when no handler is installed.
 */
export class AppServerClient {
    private readonly threadHandlers = new Map<string, NotificationHandler>();
    private readonly approvalHandlers = new Map<string, ApprovalHandler>();
    private readonly elicitationHandlers = new Map<string, ElicitationHandler>();
    private readonly turnCompletionWaiters = new Map<string, (event: TurnCompletedNotification) => void>();
    private readonly earlyTurnCompletions = new Map<string, TurnCompletedNotification>();
    private readonly startingThreads = new Map<string, number>();
    private startingReviews = 0;
    private modelCatalog: {expires: number; pending: Promise<Model[]>} | null = null;
    private readonly mcpStartupStates = new Map<string, McpStartupSnapshot>();
    private readonly mcpStartupWaiters: McpStartupWaiter[] = [];
    private readonly notificationWaiters: NotificationWaiter[] = [];
    private mcpStartupVersion = 0;
    private readonly disconnected = new AbortController();

    constructor(readonly connection: MessageConnection) {
        connection.onClose(() => this.disconnected.abort(new Error("Connection to Codex was lost")));
        connection.onDispose(() => this.disconnected.abort(new Error("Connection to Codex was lost")));
        connection.onUnhandledNotification((message) => {
            this.dispatchNotification(message as ServerNotification);
        });
        connection.onRequest(CommandExecutionApprovalRequest, async (params) => {
            const handler = this.approvalHandlers.get(params.threadId);
            return handler ? await handler.handleCommandExecution(params) : {decision: "cancel"};
        });
        connection.onRequest(FileChangeApprovalRequest, async (params) => {
            const handler = this.approvalHandlers.get(params.threadId);
            return handler ? await handler.handleFileChange(params) : {decision: "cancel"};
        });
        connection.onRequest(PermissionsApprovalRequest, async (params) => {
            const handler = this.approvalHandlers.get(params.threadId);
            return handler
                ? await handler.handlePermissionsRequest(params)
                : {permissions: {}, scope: "turn", strictAutoReview: false};
        });
        connection.onRequest(McpServerElicitationRequest, async (params) => {
            const handler = this.elicitationHandlers.get(params.threadId);
            return handler
                ? await handler.handleElicitation(params)
                : {action: "cancel", content: null, _meta: null};
        });
        connection.onRequest(ToolRequestUserInputRequest, async (params) => {
            const handler = this.elicitationHandlers.get(params.threadId);
            return handler ? await handler.handleUserInput(params) : {answers: {}};
        });
    }

    get disconnectSignal(): AbortSignal { return this.disconnected.signal; }

    // ---- thread routing -------------------------------------------------

    attachThread(threadId: string, handlers: {
        notification: NotificationHandler;
        approval: ApprovalHandler;
        elicitation: ElicitationHandler;
    }): void {
        this.threadHandlers.set(threadId, handlers.notification);
        this.approvalHandlers.set(threadId, handlers.approval);
        this.elicitationHandlers.set(threadId, handlers.elicitation);
    }

    detachThread(threadId: string): void {
        this.threadHandlers.delete(threadId);
        this.approvalHandlers.delete(threadId);
        this.elicitationHandlers.delete(threadId);
        for (const key of this.mcpStartupStates.keys()) {
            if (key.startsWith(`${threadId}\u0000`)) this.mcpStartupStates.delete(key);
        }
    }

    /**
     * Resolves with the params of the next notification matching `method`. Waiters
     * observe the stream without consuming it, so thread routing still sees the frame.
     */
    awaitNotification<M extends ServerNotification["method"]>(
        method: M,
        predicate: (params: NotificationParams<M>) => boolean = () => true,
        signal?: AbortSignal,
    ): Promise<NotificationParams<M>> {
        let waiter: NotificationWaiter;
        const settled = new Promise<unknown>((resolve) => {
            waiter = {
                method,
                matches: (params) => predicate(params as NotificationParams<M>),
                resolve,
            };
            this.notificationWaiters.push(waiter);
        });
        const result = abortable(settled, signal ? AbortSignal.any([signal, this.disconnected.signal]) : this.disconnected.signal)
            .finally(() => {
                const index = this.notificationWaiters.indexOf(waiter);
                if (index >= 0) this.notificationWaiters.splice(index, 1);
            }) as Promise<NotificationParams<M>>;
        // Waiters are installed before sending the triggering request; that request can fail first.
        void result.catch(() => {});
        return result;
    }

    /** Installs before the triggering RPC and releases the waiter even if that RPC fails. */
    async withNotification<M extends ServerNotification["method"], T>(
        method: M,
        operation: (completed: Promise<NotificationParams<M>>) => Promise<T>,
    ): Promise<T> {
        const scope = new AbortController();
        try {
            return await operation(this.awaitNotification(method, () => true, scope.signal));
        } finally {
            scope.abort();
        }
    }

    private readonly observers = new Set<NotificationHandler>();

    observeNotifications(handler: NotificationHandler): () => void {
        this.observers.add(handler);
        return () => {this.observers.delete(handler);};
    }

    private dispatchNotification(notification: ServerNotification): void {
        if (notification.method === "account/updated") this.modelCatalog = null;
        for (const observer of this.observers) observer(notification);
        if (this.notificationWaiters.length > 0) {
            const remaining: NotificationWaiter[] = [];
            for (const waiter of this.notificationWaiters) {
                if (waiter.method === notification.method && waiter.matches(notification.params)) waiter.resolve(notification.params);
                else remaining.push(waiter);
            }
            this.notificationWaiters.splice(0, this.notificationWaiters.length, ...remaining);
        }
        if (notification.method === "mcpServer/startupStatus/updated") {
            this.mcpStartupVersion += 1;
            this.mcpStartupStates.set(mcpKey(notification.params.threadId, notification.params.name), {
                status: notification.params.status,
                error: notification.params.error,
                version: this.mcpStartupVersion,
            });
            this.settleMcpStartupWaiters();
        }
        if (notification.method === "turn/completed") {
            this.recordTurnCompleted(notification.params);
        }
        const threadId = threadIdOf(notification);
        if (threadId !== null) {
            this.threadHandlers.get(threadId)?.(notification);
            return;
        }
        for (const handler of this.threadHandlers.values()) {
            handler(notification);
        }
    }

    // ---- turns ----------------------------------------------------------

    /** Starts a turn and resolves when Codex reports it completed, failed, or was interrupted. */
    async runTurn(params: TurnStartParams, onTurnStarted?: (turnId: string) => void, signal?: AbortSignal): Promise<TurnCompletedNotification> {
        this.startingThreads.set(params.threadId, (this.startingThreads.get(params.threadId) ?? 0) + 1);
        let completed: Promise<TurnCompletedNotification>;
        try {
            const started = await this.turnStart(params);
            onTurnStarted?.(started.turn.id);
            completed = this.awaitTurnCompleted(params.threadId, started.turn.id, signal);
        } finally {
            const remaining = (this.startingThreads.get(params.threadId) ?? 1) - 1;
            if (remaining === 0) this.startingThreads.delete(params.threadId);
            else this.startingThreads.set(params.threadId, remaining);
            this.pruneEarlyCompletions();
        }
        return await completed;
    }

    async runReview(params: ReviewStartParams, onTurnStarted?: (turnId: string, threadId: string) => void, signal?: AbortSignal): Promise<TurnCompletedNotification> {
        this.startingReviews += 1;
        let completed: Promise<TurnCompletedNotification>;
        try {
            const started = await this.reviewStart(params);
            onTurnStarted?.(started.turn.id, started.reviewThreadId);
            completed = this.awaitTurnCompleted(started.reviewThreadId, started.turn.id, signal);
        } finally {
            this.startingReviews -= 1;
            this.pruneEarlyCompletions();
        }
        return await completed;
    }

    awaitTurnCompleted(threadId: string, turnId: string, signal?: AbortSignal): Promise<TurnCompletedNotification> {
        const key = turnKey(threadId, turnId);
        const early = this.earlyTurnCompletions.get(key);
        if (early) {
            this.earlyTurnCompletions.delete(key);
            return Promise.resolve(early);
        }
        const lifetime = signal ? AbortSignal.any([signal, this.disconnected.signal]) : this.disconnected.signal;
        return new Promise<TurnCompletedNotification>((resolve, reject) => {
            const cleanup = () => {
                lifetime.removeEventListener("abort", aborted);
                this.turnCompletionWaiters.delete(key);
            };
            const aborted = () => { cleanup(); reject(lifetime.reason); };
            if (lifetime.aborted) { reject(lifetime.reason); return; }
            lifetime.addEventListener("abort", aborted, {once: true});
            // Remove the abort listener synchronously with delivery, before EOF can win.
            this.turnCompletionWaiters.set(key, event => { cleanup(); resolve(event); });
        });
    }

    /** Synthesizes an interrupted completion, for when Codex can no longer deliver one. */
    resolveTurnInterrupted(threadId: string, turnId: string): void {
        this.recordTurnCompleted({
            threadId,
            turn: {
                id: turnId,
                items: [],
                itemsView: "notLoaded",
                status: "interrupted",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        });
    }

    /** Synthesizes a failed completion, for when the Codex process is gone. */
    failTurn(threadId: string, turnId: string, error: TurnError): void {
        this.recordTurnCompleted({
            threadId,
            turn: {id: turnId, items: [], itemsView: "notLoaded", status: "failed", error, startedAt: null, completedAt: null, durationMs: null},
        });
    }

    private recordTurnCompleted(event: TurnCompletedNotification): void {
        const key = turnKey(event.threadId, event.turn.id);
        const waiter = this.turnCompletionWaiters.get(key);
        if (waiter) {
            this.turnCompletionWaiters.delete(key);
            waiter(event);
            return;
        }
        // turn/completed can arrive before turn/start returns for trivially short turns.
        if (this.startingThreads.has(event.threadId) || this.startingReviews > 0) this.earlyTurnCompletions.set(key, event);
    }

    private pruneEarlyCompletions(): void {
        if (this.startingReviews > 0) return;
        for (const [key, event] of this.earlyTurnCompletions) {
            if (!this.startingThreads.has(event.threadId)) this.earlyTurnCompletions.delete(key);
        }
    }

    // ---- MCP startup ----------------------------------------------------

    get mcpStartupGeneration(): number {
        return this.mcpStartupVersion;
    }

    awaitMcpStartup(serverNames: string[], afterVersion: number, signal?: AbortSignal, threadId: string | null = null): Promise<McpStartupResult> {
        const names = [...new Set(serverNames.map(name => name.trim()).filter(name => name.length > 0))];
        if (names.length === 0) return Promise.resolve({ready: [], failed: [], cancelled: []});
        const immediate = this.buildMcpStartupResult(names, afterVersion, threadId);
        if (immediate) return Promise.resolve(immediate);
        let waiter: McpStartupWaiter;
        const completed = new Promise<McpStartupResult>((resolve) => {
            waiter = {serverNames: names, afterVersion, threadId, resolve};
            this.mcpStartupWaiters.push(waiter);
        });
        return abortable(completed, signal ? AbortSignal.any([signal, this.disconnected.signal]) : this.disconnected.signal)
            .finally(() => {
                const index = this.mcpStartupWaiters.indexOf(waiter);
                if (index >= 0) this.mcpStartupWaiters.splice(index, 1);
            });
    }

    private settleMcpStartupWaiters(): void {
        const pending: McpStartupWaiter[] = [];
        for (const waiter of this.mcpStartupWaiters) {
            const result = this.buildMcpStartupResult(waiter.serverNames, waiter.afterVersion, waiter.threadId);
            if (result) waiter.resolve(result);
            else pending.push(waiter);
        }
        this.mcpStartupWaiters.splice(0, this.mcpStartupWaiters.length, ...pending);
    }

    private buildMcpStartupResult(serverNames: string[], afterVersion: number, threadId: string | null): McpStartupResult | null {
        const result: McpStartupResult = {ready: [], failed: [], cancelled: []};
        for (const name of serverNames) {
            const scoped = this.mcpStartupStates.get(mcpKey(threadId, name));
            const global = this.mcpStartupStates.get(mcpKey(null, name));
            const state = scoped && scoped.version > afterVersion ? scoped : global;
            if (!state || state.version <= afterVersion || state.status === "starting") return null;
            if (state.status === "ready") result.ready.push(name);
            else if (state.status === "failed") result.failed.push({server: name, error: state.error ?? "unknown MCP startup error"});
            else result.cancelled.push(name);
        }
        return result;
    }

    // ---- typed requests -------------------------------------------------

    initialize(params: InitializeParams): Promise<InitializeResponse> {
        return this.send({method: "initialize", params});
    }

    threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
        return this.send({method: "thread/start", params});
    }

    threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
        return this.send({method: "thread/resume", params});
    }

    threadFork(params: ThreadForkParams): Promise<ThreadForkResponse> {
        return this.send({method: "thread/fork", params});
    }

    threadRead(params: ThreadReadParams): Promise<ThreadReadResponse> {
        return this.send({method: "thread/read", params});
    }

    threadList(params: ThreadListParams): Promise<ThreadListResponse> {
        return this.send({method: "thread/list", params});
    }

    threadTurnsList(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> {
        return this.send({method: "thread/turns/list", params});
    }

    threadArchive(params: ThreadArchiveParams): Promise<ThreadArchiveResponse> {
        return this.send({method: "thread/archive", params});
    }

    threadUnarchive(params: ThreadUnarchiveParams): Promise<ThreadUnarchiveResponse> {
        return this.send({method: "thread/unarchive", params});
    }

    threadDelete(params: ThreadDeleteParams): Promise<ThreadDeleteResponse> {
        return this.send({method: "thread/delete", params});
    }

    threadInjectItems(params: ThreadInjectItemsParams): Promise<ThreadInjectItemsResponse> {
        return this.send({method: "thread/inject_items", params});
    }

    threadUnsubscribe(params: ThreadUnsubscribeParams): Promise<ThreadUnsubscribeResponse> {
        return this.send({method: "thread/unsubscribe", params});
    }

    threadCompactStart(params: ThreadCompactStartParams): Promise<ThreadCompactStartResponse> {
        return this.send({method: "thread/compact/start", params});
    }

    async threadSettingsUpdate(params: ThreadSettingsUpdateParams): Promise<void> {
        this.disconnected.signal.throwIfAborted();
        logger.log("[codex request]", {method: "thread/settings/update"});
        await abortable(this.connection.sendRequest("thread/settings/update", params), this.disconnected.signal);
    }

    turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
        return this.send({method: "turn/start", params});
    }

    turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
        return this.send({method: "turn/interrupt", params});
    }

    turnSteer(params: TurnSteerParams): Promise<TurnSteerResponse> {
        return this.send({method: "turn/steer", params});
    }

    reviewStart(params: ReviewStartParams): Promise<ReviewStartResponse> {
        return this.send({method: "review/start", params});
    }

    modelList(params: ModelListParams): Promise<ModelListResponse> {
        return this.send({method: "model/list", params});
    }

    /** Fetches every page of the model catalog. */
    invalidateModels(): void { this.modelCatalog = null; }

    allModels(refresh = false): Promise<Model[]> {
        if (!refresh && this.modelCatalog && this.modelCatalog.expires > performance.now()) return this.modelCatalog.pending;
        const pending = this.loadModels();
        const entry = {expires: performance.now() + 30_000, pending};
        this.modelCatalog = entry;
        void pending.catch(() => {if (this.modelCatalog === entry) this.modelCatalog = null;});
        return pending;
    }

    private async loadModels(): Promise<Model[]> {
        const models: Model[] = [];
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
            const page: ModelListResponse = await this.modelList({cursor, limit: null});
            models.push(...page.data);
            cursor = page.nextCursor;
            if (cursor) {
                if (cursors.has(cursor)) throw new Error("Codex model/list returned a repeated pagination cursor; retry after restarting Codex");
                cursors.add(cursor);
            }
        } while (cursor);
        return models;
    }

    skillsList(params: SkillsListParams): Promise<SkillsListResponse> {
        return this.send({method: "skills/list", params});
    }

    skillsExtraRootsSet(params: SkillsExtraRootsSetParams): Promise<void> {
        return this.send({method: "skills/extraRoots/set", params});
    }

    skillsConfigWrite(params: SkillsConfigWriteParams): Promise<SkillsConfigWriteResponse> {
        return this.send({method: "skills/config/write", params});
    }

    pluginList(params: PluginListParams): Promise<PluginListResponse> {
        return this.send({method: "plugin/list", params});
    }

    pluginInstalled(params: PluginInstalledParams): Promise<PluginInstalledResponse> {
        return this.send({method: "plugin/installed", params});
    }

    pluginInstall(params: PluginInstallParams): Promise<PluginInstallResponse> {
        return this.send({method: "plugin/install", params});
    }

    pluginUninstall(params: PluginUninstallParams): Promise<PluginUninstallResponse> {
        return this.send({method: "plugin/uninstall", params});
    }

    pluginRead(params: PluginReadParams): Promise<PluginReadResponse> {
        return this.send({method: "plugin/read", params});
    }

    marketplaceAdd(params: MarketplaceAddParams): Promise<MarketplaceAddResponse> {
        return this.send({method: "marketplace/add", params});
    }

    marketplaceRemove(params: MarketplaceRemoveParams): Promise<MarketplaceRemoveResponse> {
        return this.send({method: "marketplace/remove", params});
    }

    marketplaceUpgrade(params: MarketplaceUpgradeParams): Promise<MarketplaceUpgradeResponse> {
        return this.send({method: "marketplace/upgrade", params});
    }

    accountRead(params: GetAccountParams): Promise<GetAccountResponse> {
        return this.send({method: "account/read", params});
    }

    accountRateLimitsRead(): Promise<GetAccountRateLimitsResponse> {
        return this.send({method: "account/rateLimits/read", params: undefined});
    }

    threadSetName(params: ThreadSetNameParams): Promise<ThreadSetNameResponse> {
        return this.send({method: "thread/name/set", params});
    }

    fuzzyFileSearch(params: FuzzyFileSearchParams): Promise<FuzzyFileSearchResponse> {
        return this.send({method: "fuzzyFileSearch", params});
    }

    accountLogin(params: LoginAccountParams): Promise<LoginAccountResponse> {
        return this.send({method: "account/login/start", params});
    }

    accountLoginCancel(params: CancelLoginAccountParams): Promise<CancelLoginAccountResponse> {
        return this.send({method: "account/login/cancel", params});
    }

    accountLogout(): Promise<LogoutAccountResponse> {
        return this.send({method: "account/logout", params: undefined});
    }

    configRead(params: ConfigReadParams): Promise<ConfigReadResponse> {
        return this.send({method: "config/read", params});
    }

    mcpServerStatusList(params: ListMcpServerStatusParams): Promise<ListMcpServerStatusResponse> {
        return this.send({method: "mcpServerStatus/list", params});
    }

    private async send<R>(request: CodexRequest): Promise<R> {
        this.disconnected.signal.throwIfAborted();
        logger.log("[codex request]", {method: request.method});
        const params: unknown = "params" in request ? request.params : undefined;
        return await abortable(params === undefined
            ? this.connection.sendRequest<R>(request.method)
            : this.connection.sendRequest<R>(request.method, params), this.disconnected.signal);
    }
}

function turnKey(threadId: string, turnId: string): string {
    return `${threadId} ${turnId}`;
}

function mcpKey(threadId: string | null, name: string): string {
    return `${threadId ?? ""}\u0000${name}`;
}

export function threadIdOf(notification: ServerNotification): string | null {
    const params = notification.params as {threadId?: unknown} | undefined;
    return params && typeof params.threadId === "string" ? params.threadId : null;
}
