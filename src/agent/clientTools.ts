import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {DynamicToolCallParams, DynamicToolCallResponse, DynamicToolSpec} from "../app-server/v2";
import type {JsonValue} from "../app-server/serde_json/JsonValue";
import type {ClientSession} from "./clientSession";
import type {Session, ActiveTurn} from "./session";
import {abortable} from "../util/abort";

export const CLIENT_TOOLS_METHOD = "_alwith/tool/call";
export type ClientTool = {name: string; description: string; inputSchema: JsonValue};
export type ClientToolSet = {version: 1; revision: string; definitions: ClientTool[]};
const PREFIX = "alwith_client_";
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function clientToolsOf(meta: unknown): ClientToolSet | undefined {
    if (!record(meta) || !record(meta["alwith"]) || meta["alwith"]["tools"] === undefined) return undefined;
    const value = meta["alwith"]["tools"];
    if (!record(value) || value["version"] !== 1 || typeof value["revision"] !== "string" || !value["revision"].trim()
        || !Array.isArray(value["definitions"]) || value["definitions"].length > 128) {
        throw acp.RequestError.invalidParams(undefined, "Expected a version 1 client tool set with revision and definitions");
    }
    const names = new Set<string>();
    const definitions = value["definitions"].map((tool): ClientTool => {
        if (!record(tool) || typeof tool["name"] !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(tool["name"])
            || names.has(tool["name"]) || typeof tool["description"] !== "string" || !record(tool["inputSchema"])
            || tool["inputSchema"]["type"] !== "object") {
            throw acp.RequestError.invalidParams(undefined, "Client tools require unique names, descriptions and object input schemas");
        }
        names.add(tool["name"]);
        return {name: tool["name"], description: tool["description"], inputSchema: structuredClone(tool["inputSchema"]) as JsonValue};
    });
    return {version: 1, revision: value["revision"], definitions};
}

export function dynamicTools(set: ClientToolSet): DynamicToolSpec[] {
    return set.definitions.map(tool => ({type: "function", ...tool, name: PREFIX + tool["name"], deferLoading: false}));
}

function failure(message: string): DynamicToolCallResponse {
    return {success: false, contentItems: [{type: "inputText", text: message}]};
}

export function toolResponse(value: unknown): DynamicToolCallResponse {
    if (!record(value) || typeof value["success"] !== "boolean" || !Array.isArray(value["contentItems"])
        || Buffer.byteLength(JSON.stringify(value)) > MAX_RESULT_BYTES) {
        throw new Error("Invalid or oversized client tool result");
    }
    const contentItems = value["contentItems"].map((item): DynamicToolCallResponse["contentItems"][number] => {
        if (!record(item)) throw new Error("Invalid client tool content");
        if (item["type"] === "text" && typeof item["text"] === "string") return {type: "inputText", text: item["text"]};
        if ((item["type"] === "image" || item["type"] === "audio") && typeof item["data"] === "string" && typeof item["mimeType"] === "string"
            && /^[A-Za-z0-9+/]*={0,2}$/.test(item["data"])) {
            const supported = item["type"] === "image" ? /^image\/(png|jpeg|webp|gif)$/ : /^audio\/(wav|mpeg|mp3|ogg|flac|mp4)$/;
            if (!supported.test(item["mimeType"])) throw new Error("Unsupported client tool media type");
            const url = `data:${item["mimeType"]};base64,${item["data"]}`;
            return item["type"] === "image" ? {type: "inputImage", imageUrl: url} : {type: "inputAudio", audioUrl: url};
        }
        // Resource references must be resolved by the trusted host, never by fetching an arbitrary URL here.
        throw new Error("Client tool content must be text or bounded inline media");
    });
    return {success: value["success"], contentItems};
}

/** Cached per ActiveTurn identity: a repeated call never repeats a write; a new turn gets a fresh ledger. */
export class ClientTools {
    private readonly calls = new WeakMap<ActiveTurn, Map<string, {fingerprint: string; response: Promise<DynamicToolCallResponse>}>>();
    constructor(private readonly session: Session, private readonly client: ClientSession, private readonly lifetime: AbortSignal) {}

    call(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
        const turn = this.session.activeTurn;
        const set = this.session.clientTools;
        if (!turn || !set || this.session.closed || this.lifetime.aborted || turn.abort.signal.aborted
            || params.threadId !== this.session.id || params.namespace !== null
            || (turn.turnId !== null && params.turnId !== turn.turnId)) return Promise.resolve(failure("Client tool turn is no longer active"));
        const tool = set.definitions.find(tool => PREFIX + tool["name"] === params.tool);
        if (!tool) return Promise.resolve(failure("Client tool was not declared for this session"));
        let calls = this.calls.get(turn);
        if (!calls) { calls = new Map(); this.calls.set(turn, calls); }
        const fingerprint = JSON.stringify([params.tool, params.arguments, set.revision]);
        const previous = calls.get(params.callId);
        if (previous) return previous.fingerprint === fingerprint ? previous.response : Promise.resolve(failure("Client tool call ID was reused with different arguments"));
        const response = this.execute(turn, set, tool, params);
        calls.set(params.callId, {fingerprint, response});
        return response;
    }

    private async execute(turn: ActiveTurn, set: ClientToolSet, tool: ClientTool, params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
        const signal = AbortSignal.any([this.lifetime, this.client.signal, turn.abort.signal, turn.stop.signal]);
        try {
            signal.throwIfAborted();
            const turnId = turn.turnId ?? await abortable(turn.started, signal);
            if (turnId !== params.turnId || this.session.activeTurn !== turn) return failure("Client tool turn is no longer active");
            if (this.session.mode.approvalPolicy !== "never") {
                const permission = await this.client.requestPermission({
                    title: `Run ${tool["name"]}?`,
                    subject: {type: "tool_call", toolCall: {toolCallId: params.callId, name: tool["name"], title: tool["description"], kind: "other", status: "pending"}},
                    options: [{optionId: "allow_once", name: "Allow", kind: "allow_once"}, {optionId: "reject_once", name: "Reject", kind: "reject_once"}],
                }, signal);
                if (permission.outcome.outcome !== "selected" || permission.outcome.optionId !== "allow_once") return failure("Client tool permission was denied");
            }
            signal.throwIfAborted();
            const value = await abortable(this.client.requestTool({sessionId: this.session.id, turnId: params.turnId,
                toolCallId: params.callId, name: tool["name"], arguments: params.arguments, toolSetRevision: set.revision}, signal), signal);
            if (this.session.activeTurn !== turn) return failure("Client tool turn is no longer active");
            signal.throwIfAborted();
            return toolResponse(value);
        } catch {
            return failure(signal.aborted ? "Client tool call was cancelled" : "Client tool call failed");
        }
    }
}
