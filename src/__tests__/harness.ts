import {CWD, THREAD_ID, TURN_ID, model, thread, turn, threadResponse} from "./fixtures";
export {CWD, THREAD_ID, TURN_ID, model, thread, turn, threadResponse} from "./fixtures";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {Disposable, MessageConnection, RequestType} from "vscode-jsonrpc/node";
import {expect, vi} from "vitest";
import type {ServerNotification} from "../app-server";
import type {Model, Thread, ThreadItem, Turn} from "../app-server/v2";
import {CodexAgent} from "../agent/CodexAgent";
import type {ClientLink} from "../agent/clientSession";
import {AppServerClient} from "../codex/AppServerClient";
import type {CodexProcess} from "../codex/process";

export type RecordedRequest = {method: string; params: unknown};
export type ScriptedResponse = (params: any) => unknown | Promise<unknown>;

/**
 * In-memory stand-in for the vscode-jsonrpc connection to `codex app-server`.
 * Requests are answered by scripted handlers; notifications and server-initiated
 * requests are injected by tests.
 */
export class FakeCodexConnection {
    readonly requests: RecordedRequest[] = [];
    private readonly responses = new Map<string, ScriptedResponse>();
    private readonly notificationHandlers = new Map<string, Set<(...args: unknown[]) => void>>();
    private readonly requestHandlers = new Map<string, (params: unknown) => unknown>();
    private readonly closeHandlers: Array<() => void> = [];
    private unhandled: ((message: unknown) => void) | null = null;

    respond(method: string, handler: ScriptedResponse): void {
        this.responses.set(method, handler);
    }

    /** Delivers a server notification the way the transport would. */
    emit(notification: ServerNotification): void {
        const handlers = this.notificationHandlers.get(notification.method);
        if (handlers && handlers.size > 0) {
            for (const handler of handlers) handler(notification.params);
            return;
        }
        this.unhandled?.(notification);
    }

    /** Invokes a Codex → adapter request such as an approval prompt. */
    serverRequest<R>(method: string, params: unknown): Promise<R> {
        const handler = this.requestHandlers.get(method);
        if (!handler) throw new Error(`No handler registered for ${method}`);
        return Promise.resolve(handler(params) as R);
    }

    close(): void {
        for (const handler of this.closeHandlers) handler();
    }

    calls(method: string): RecordedRequest[] {
        return this.requests.filter(request => request.method === method);
    }

    lastParams<T>(method: string): T {
        const call = this.calls(method).at(-1);
        if (!call) throw new Error(`No ${method} request recorded`);
        return call.params as T;
    }

    asMessageConnection(): MessageConnection {
        const connection = {
            sendRequest: async (method: string, params?: unknown) => {
                this.requests.push({method, params});
                const handler = this.responses.get(method);
                if (!handler) throw new Error(`Unscripted codex request: ${method}`);
                return await handler(params);
            },
            onUnhandledNotification: (handler: (message: unknown) => void) => {
                this.unhandled = handler;
                return {dispose() {}};
            },
            onNotification: (method: string, handler: (...args: unknown[]) => void): Disposable => {
                const handlers = this.notificationHandlers.get(method) ?? new Set();
                handlers.add(handler);
                this.notificationHandlers.set(method, handlers);
                return {dispose: () => handlers.delete(handler)};
            },
            onRequest: (type: RequestType<unknown, unknown, void>, handler: (params: unknown) => unknown) => {
                this.requestHandlers.set(type.method, handler);
                return {dispose() {}};
            },
            onClose: (handler: () => void) => {
                this.closeHandlers.push(handler);
                return {dispose() {}};
            },
            onDispose: (handler: () => void) => {
                this.closeHandlers.push(handler);
                return {dispose() {}};
            },
            listen() {},
            dispose() {},
        };
        return connection as unknown as MessageConnection;
    }
}

export type RecordedUpdate = acp.SessionUpdate & {sessionId: string};

/** Records everything the agent sends to the client and answers its requests. */
export class FakeClient implements ClientLink {
    readonly notifications: Array<{method: string; params: unknown}> = [];
    readonly requests: Array<{method: string; params: unknown}> = [];
    permissionResponder: (request: acp.RequestPermissionRequest) => acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse> =
        () => ({outcome: {outcome: "cancelled"}});
    elicitationResponder: (request: acp.CreateElicitationRequest) => acp.CreateElicitationResponse | Promise<acp.CreateElicitationResponse> =
        () => ({action: "cancel"});

    notify = vi.fn(async (method: string, params?: unknown): Promise<void> => {
        this.notifications.push({method, params});
    }) as unknown as ClientLink["notify"];

    request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
        this.requests.push({method, params});
        if (method === acp.methods.client.session.requestPermission) {
            return await this.permissionResponder(params as acp.RequestPermissionRequest);
        }
        if (method === acp.methods.client.elicitation.create) {
            return await this.elicitationResponder(params as acp.CreateElicitationRequest);
        }
        throw new Error(`Unexpected client request ${method}`);
    }) as unknown as ClientLink["request"];

    updates(): RecordedUpdate[] {
        return this.notifications
            .filter(entry => entry.method === acp.methods.client.session.update)
            .map(entry => {
                const params = entry.params as acp.UpdateSessionNotification;
                return {sessionId: params.sessionId, ...params.update} as RecordedUpdate;
            });
    }

    updatesOf<K extends acp.SessionUpdate["sessionUpdate"]>(kind: K): Array<Extract<RecordedUpdate, {sessionUpdate: K}>> {
        return this.updates().filter((update): update is Extract<RecordedUpdate, {sessionUpdate: K}> => update.sessionUpdate === kind);
    }

    states(): string[] {
        return this.updatesOf("state_update").map(update => update.state);
    }

    permissionRequests(): acp.RequestPermissionRequest[] {
        return this.requests
            .filter(entry => entry.method === acp.methods.client.session.requestPermission)
            .map(entry => entry.params as acp.RequestPermissionRequest);
    }

    clear(): void {
        this.notifications.length = 0;
        this.requests.length = 0;
    }
}

export function itemStarted(codex: FakeCodexConnection, item: ThreadItem, turnId = TURN_ID): void {
    codex.emit({method: "item/started", params: {threadId: THREAD_ID, turnId, item, startedAtMs: 0}});
}

export function itemCompleted(codex: FakeCodexConnection, item: ThreadItem, turnId = TURN_ID): void {
    codex.emit({method: "item/completed", params: {threadId: THREAD_ID, turnId, item, completedAtMs: 0}});
}

export function turnCompleted(codex: FakeCodexConnection, overrides: Partial<Turn> = {}): void {
    codex.emit({method: "turn/completed", params: {threadId: THREAD_ID, turn: turn(overrides)}});
}

export interface TestAgent {
    agent: CodexAgent;
    codex: FakeCodexConnection;
    client: FakeClient;
    /** Waits for queued notification handling and promise chains to settle. */
    settle(): Promise<void>;
    initialize(capabilities?: acp.ClientCapabilities): Promise<acp.InitializeResponse>;
    openSession(request?: Partial<acp.NewSessionRequest>): Promise<acp.NewSessionResponse>;
}

export function createTestAgent(options: {env?: NodeJS.ProcessEnv; catalog?: Model[]; closeGraceMs?: number; codexStderr?: string} = {}): TestAgent {
    const codex = new FakeCodexConnection();
    const client = new FakeClient();
    const catalog = options.catalog ?? [model()];
    codex.respond("initialize", () => ({userAgent: "codex", codexHome: "/home/codex", platformFamily: "unix", platformOs: "macos"}));
    codex.respond("account/read", () => ({account: {type: "chatgpt", email: "dev@example.com", planType: "pro"}, requiresOpenaiAuth: true}));
    codex.respond("config/read", () => ({config: {}, origins: {}, layers: []}));
    codex.respond("skills/extraRoots/set", () => ({}));
    codex.respond("skills/list", () => ({data: []}));
    codex.respond("model/list", () => ({data: catalog, nextCursor: null}));
    codex.respond("thread/start", () => threadResponse());
    codex.respond("thread/resume", (params) => threadResponse({id: params.threadId}));
    codex.respond("thread/fork", () => threadResponse({id: "thread-fork", forkedFromId: THREAD_ID}));
    codex.respond("thread/read", (params) => ({thread: thread({id: params.threadId})}));
    codex.respond("thread/list", () => ({data: [], nextCursor: null, backwardsCursor: null}));
    codex.respond("thread/turns/list", () => ({data: [], nextCursor: null, backwardsCursor: null}));
    codex.respond("thread/unsubscribe", () => ({}));
    codex.respond("thread/archive", () => ({}));
    codex.respond("thread/unarchive", () => ({}));
    codex.respond("thread/delete", () => ({}));
    codex.respond("thread/inject_items", () => ({}));
    codex.respond("thread/compact/start", () => ({}));
    codex.respond("thread/settings/update", () => ({}));
    codex.respond("turn/start", () => ({turn: turn({status: "inProgress"})}));
    codex.respond("turn/interrupt", () => ({}));
    codex.respond("turn/steer", () => ({turnId: TURN_ID}));
    codex.respond("mcpServerStatus/list", () => ({data: [], nextCursor: null}));
    codex.respond("account/logout", () => ({}));
    codex.respond("review/start", () => ({turn: turn({id: "review-turn", status: "inProgress"}), reviewThreadId: THREAD_ID}));
    codex.respond("account/login/cancel", () => ({status: "cancelled"}));

    const appServer = new AppServerClient(codex.asMessageConnection());
    const agent = new CodexAgent(client, {
        codex: appServer,
        info: {name: "codex-acp-v2-test", version: "0.0.0"},
        env: options.env ?? {},
        ...(options.closeGraceMs === undefined ? {} : {closeGraceMs: options.closeGraceMs}),
        ...(options.codexStderr === undefined ? {} : {process: fakeProcess(options.codexStderr)}),
    });
    const settle = async () => {
        for (let index = 0; index < 8; index += 1) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    };
    return {
        agent,
        codex,
        client,
        settle,
        initialize: (capabilities) => agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            info: {name: "test-client", version: "1.0.0"},
            ...(capabilities ? {capabilities} : {}),
        }),
        openSession: async (request) => {
            const response = await agent.newSession({cwd: CWD, mcpServers: [], ...request});
            await settle();
            client.clear();
            return response;
        },
    };
}

export async function expectRejects(promise: Promise<unknown>, code: number, messagePart?: string): Promise<acp.RequestError> {
    let caught: unknown;
    try {
        await promise;
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(acp.RequestError);
    const error = caught as acp.RequestError;
    expect(error.code).toBe(code);
    if (messagePart) expect(error.message).toContain(messagePart);
    return error;
}

/** Stands in for a spawned Codex whose stderr tail is known; never exits on its own. */
function fakeProcess(stderr: string): CodexProcess {
    return {
        exited: new Promise<number | null>(() => {}),
        recentStderr: () => stderr,
        exitCode: () => null,
    } as unknown as CodexProcess;
}
