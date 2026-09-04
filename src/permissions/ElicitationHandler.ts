import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {ServerNotification} from "../app-server";
import type {JsonValue} from "../app-server/serde_json/JsonValue";
import type {
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    ToolRequestUserInputParams,
    ToolRequestUserInputResponse,
} from "../app-server/v2";
import type {ClientSession} from "../agent/clientSession";
import type {ElicitationHandler} from "../codex/AppServerClient";
import {logger} from "../util/logger";
import {isRecord, normalizeJsonObject, normalizeJsonValue, recordOrNull} from "./json";
import {
    cancelled,
    isMcpToolCallApproval,
    mcpPermissionRequest,
    mcpPermissionResponse,
    parsePersistOptions,
    type McpElicitationContext,
    type PersistValue,
} from "./mcp";
import type {TurnContext} from "./turnContext";

type AcpBackedParams = Extract<McpServerElicitationRequestParams, {mode: "form"} | {mode: "url"}>;
type ContentRecord = Record<string, acp.ElicitationContentValue>;

const OTHER_SUFFIX = "__other";

/**
 * Routes Codex MCP elicitations and tool user-input questions to the client.
 * Structured forms and URLs use `elicitation/create` when the client supports
 * it; message-only requests fall back to `session/request_permission` so every
 * client can still answer them.
 */
export class CodexElicitationHandler implements ElicitationHandler {
    /** URL elicitations Codex has accepted; completed once the server request resolves. */
    private readonly pendingUrlElicitations = new Set<string>();

    constructor(
        private readonly client: ClientSession,
        private readonly turn: TurnContext,
        private readonly signal: () => AbortSignal | undefined = () => undefined,
    ) {}

    async observe(notification: ServerNotification): Promise<void> {
        if (notification.method !== "serverRequest/resolved") return;
        const ids = [...this.pendingUrlElicitations];
        this.pendingUrlElicitations.clear();
        for (const elicitationId of ids) {
            await this.client.completeElicitation(elicitationId);
        }
    }

    async handleElicitation(params: McpServerElicitationRequestParams): Promise<McpServerElicitationRequestResponse> {
        try {
            const context = this.mcpContext(params);
            const messageOnly = isMessageOnlyForm(params);
            if (!messageOnly && this.useAcpElicitation(params)) {
                const response = await this.client.createElicitation(this.elicitationRequest(params, context), this.signal());
                const result = convertMcpElicitationResponse(response, context);
                if (params.mode === "url" && result.action === "accept") this.pendingUrlElicitations.add(params.elicitationId);
                if (result.action === "accept") await this.markCorrelatedCallRunning(context);
                return result;
            }
            if (params.mode !== "url" && !messageOnly) {
                // A structured form the client cannot render must not degrade into an approval
                // that silently drops required input.
                return cancelled();
            }
            const request = mcpPermissionRequest(params, context, () => this.turn.nextStandaloneToolCallId(params.serverName));
            const response = await this.client.requestPermission(request, this.signal());
            const result = mcpPermissionResponse(response, context.isToolApproval, context.persistOptions);
            if (result.action === "accept") await this.markCorrelatedCallRunning(context);
            return result;
        } catch (error) {
            logger.error("MCP elicitation failed", error, {server: params.serverName});
            return cancelled();
        }
    }

    async handleUserInput(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse> {
        if (!this.client.capabilities.formElicitation) return {answers: {}};
        try {
            const response = await this.client.createElicitation(userInputRequest(this.client.sessionId, params), this.signal());
            return convertUserInputResponse(response, params);
        } catch (error) {
            logger.error("user input request failed", error, {itemId: params.itemId});
            return {answers: {}};
        }
    }

    private mcpContext(params: McpServerElicitationRequestParams): McpElicitationContext {
        const isToolApproval = isMcpToolCallApproval(params._meta) && isMessageOnlyForm(params);
        return {
            isToolApproval,
            persistOptions: parsePersistOptions(params._meta),
            correlatedCallId: isToolApproval ? this.turn.popPendingMcpCall(params.serverName) : undefined,
        };
    }

    private useAcpElicitation(params: McpServerElicitationRequestParams): params is AcpBackedParams {
        if (params.mode === "form") return this.client.capabilities.formElicitation;
        if (params.mode === "url") return this.client.capabilities.urlElicitation;
        return false;
    }

    private elicitationRequest(params: AcpBackedParams, context: McpElicitationContext): acp.CreateElicitationRequest {
        const base = {
            sessionId: this.client.sessionId,
            ...(context.correlatedCallId ? {toolCallId: context.correlatedCallId} : {}),
            message: params.message,
            _meta: recordOrNull(params._meta),
        };
        if (params.mode === "form") {
            return {...base, mode: "form", requestedSchema: normalizeSchema(params.requestedSchema)};
        }
        return {...base, mode: "url", url: params.url, elicitationId: params.elicitationId};
    }

    private async markCorrelatedCallRunning(context: McpElicitationContext): Promise<void> {
        if (context.correlatedCallId === undefined) return;
        await this.client.update({sessionUpdate: "tool_call_update", toolCallId: context.correlatedCallId, status: "in_progress"});
    }
}

function isMessageOnlyForm(params: McpServerElicitationRequestParams): boolean {
    if (params.mode !== "form" && params.mode !== "openai/form" && params.mode !== "openaiForm") return false;
    const schema: unknown = params.requestedSchema;
    if (schema === null) return true;
    if (!isRecord(schema)) return false;
    return schema["type"] === "object" && isRecord(schema["properties"]) && Object.keys(schema["properties"]).length === 0;
}

/** MCP enum schemas use `enum` + `enumNames`; ACP wants `oneOf` with titles. */
function normalizeSchema(value: unknown): acp.ElicitationSchema {
    const normalized = normalizeSchemaValue(value);
    if (!isRecord(normalized)) return {type: "object", properties: {}};
    return {...normalized, type: "object"} as acp.ElicitationSchema;
}

function normalizeSchemaValue(value: unknown): unknown {
    if (typeof value === "bigint") return Number(value);
    if (Array.isArray(value)) return value.map(normalizeSchemaValue);
    if (!isRecord(value)) return value;
    const result: Record<string, unknown> = Object.fromEntries(
        Object.entries(value).filter(([, nested]) => nested !== undefined).map(([key, nested]) => [key, normalizeSchemaValue(nested)]),
    );
    if (result["type"] === "string" && Array.isArray(result["enum"]) && Array.isArray(result["enumNames"]) && !Array.isArray(result["oneOf"])) {
        const values = result["enum"];
        const names = result["enumNames"];
        result["oneOf"] = values.map((entry, index) => ({const: String(entry), title: String(names[index] ?? entry)}));
        delete result["enum"];
        delete result["enumNames"];
    }
    return result;
}

function convertMcpElicitationResponse(response: acp.CreateElicitationResponse, context: McpElicitationContext): McpServerElicitationRequestResponse {
    if (acp.CreateElicitationResponse.isAccept(response)) {
        const content: ContentRecord = isRecord(response.content) ? {...(response.content as ContentRecord)} : {};
        const persist = context.isToolApproval ? content["persist"] : undefined;
        if (context.isToolApproval && !persistAllowed(persist, context.persistOptions)) return cancelled();
        if (persist === "session" || persist === "always" || persist === "once") delete content["persist"];
        return {action: "accept", content: contentOrNull(content), _meta: responseMeta(response, context, persist)};
    }
    if (acp.CreateElicitationResponse.isDecline(response)) {
        return context.isToolApproval
            ? {action: "cancel", content: null, _meta: responseMeta(response, context)}
            : {action: "decline", content: null, _meta: responseMeta(response, context)};
    }
    if (acp.CreateElicitationResponse.isCancel(response)) {
        return {action: "cancel", content: null, _meta: responseMeta(response, context)};
    }
    return cancelled();
}

function persistAllowed(persist: acp.ElicitationContentValue | undefined, options: ReadonlySet<PersistValue>): boolean {
    return persist === undefined
        || persist === "once"
        || (persist === "session" && options.has("session"))
        || (persist === "always" && options.has("always"));
}

function contentOrNull(content: ContentRecord): JsonValue | null {
    const entries = Object.entries(content);
    if (entries.length === 0) return null;
    return Object.fromEntries(entries.map(([key, value]) => [key, normalizeJsonValue(value)]));
}

function responseMeta(response: acp.CreateElicitationResponse, context: McpElicitationContext, persist?: unknown): JsonValue | null {
    const source = recordOrNull(response._meta);
    const meta = source ? normalizeJsonObject(source) : {};
    if (context.isToolApproval) delete meta["persist"];
    if (persist === "session" || persist === "always") meta["persist"] = persist;
    return Object.keys(meta).length === 0 ? null : meta;
}

// ---- tool user input --------------------------------------------------------------

function userInputRequest(sessionId: string, params: ToolRequestUserInputParams): acp.CreateElicitationRequest {
    const properties: Record<string, acp.ElicitationPropertySchema> = {};
    const required: string[] = [];
    const ids = new Set(params.questions.map(question => question.id));
    for (const question of params.questions) {
        const options = question.options ?? [];
        const hasOther = question.isOther && options.length > 0;
        const base = {
            title: question.header || question.id,
            description: question.question,
            _meta: {codex: {isOther: question.isOther, isSecret: question.isSecret}},
        };
        if (!hasOther) required.push(question.id);
        properties[question.id] = options.length > 0
            ? {...base, type: "string", oneOf: options.map(option => ({const: option.label, title: option.label, description: option.description}))}
            : {...base, type: "string"};
        if (hasOther) {
            properties[otherFieldId(question.id, ids)] = {
                type: "string",
                title: "Other",
                description: "Type your own answer instead of choosing an option above.",
                _meta: {codex: {questionId: question.id, isOtherAnswer: true, isSecret: question.isSecret}},
            };
        }
    }
    const first = params.questions[0];
    return {
        sessionId,
        toolCallId: params.itemId,
        mode: "form",
        message: params.questions.length === 1 && first ? first.question : "Input requested",
        requestedSchema: {type: "object", properties, required},
        _meta: {codex: {isBlocking: params.isBlocking}},
    };
}

function convertUserInputResponse(response: acp.CreateElicitationResponse, params: ToolRequestUserInputParams): ToolRequestUserInputResponse {
    if (!acp.CreateElicitationResponse.isAccept(response)) return {answers: {}};
    const content: ContentRecord = isRecord(response.content) ? (response.content as ContentRecord) : {};
    const ids = new Set(params.questions.map(question => question.id));
    const answers: ToolRequestUserInputResponse["answers"] = {};
    for (const question of params.questions) {
        const hasOther = question.isOther && (question.options?.length ?? 0) > 0;
        const value = (hasOther ? answerValue(content, otherFieldId(question.id, ids)) : undefined) ?? answerValue(content, question.id);
        if (value === undefined) continue;
        answers[question.id] = {answers: Array.isArray(value) ? value.map(String) : [String(value)]};
    }
    return {answers};
}

function answerValue(content: ContentRecord, fieldId: string): acp.ElicitationContentValue | undefined {
    const value = content[fieldId];
    if (typeof value === "string" && value.trim() === "") return undefined;
    if (Array.isArray(value) && value.length === 0) return undefined;
    return value;
}

function otherFieldId(questionId: string, ids: Set<string>): string {
    const base = `${questionId}${OTHER_SUFFIX}`;
    if (!ids.has(base)) return base;
    let index = 1;
    while (ids.has(`${base}${index}`)) index += 1;
    return `${base}${index}`;
}
