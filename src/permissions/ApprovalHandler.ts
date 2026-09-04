import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    GrantedPermissionProfile,
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
    RequestPermissionProfile,
} from "../app-server/v2";
import type {ApprovalHandler} from "../codex/AppServerClient";
import type {ClientSession} from "../agent/clientSession";
import {logger} from "../util/logger";
import type {CommandApprovalParams} from "./commandDecisions";
import {commandDecisionOptions, fileChangeDecisionOptions, OptionId, permissionProfileOptions, selectedDecision} from "./options";
import {commandSubject, COMMAND_TITLE, FILE_CHANGE_TITLE, fileChangeSubject, NETWORK_TITLE, PERMISSIONS_TITLE, permissionsSubject} from "./presentation";
import type {TurnContext} from "./turnContext";

/**
 * Bridges Codex approval requests to ACP `session/request_permission`. Every
 * option maps back to the exact Codex decision it was created from; anything
 * else (cancelled, unknown option, transport error) fails closed.
 */
export class CodexApprovalHandler implements ApprovalHandler {
    constructor(
        private readonly client: ClientSession,
        private readonly turn: TurnContext,
        private readonly signal: () => AbortSignal | undefined = () => undefined,
    ) {}

    async handleCommandExecution(params: CommandExecutionRequestApprovalParams): Promise<CommandExecutionRequestApprovalResponse> {
        const approvalParams = params as CommandApprovalParams;
        const decisions = commandDecisionOptions(approvalParams);
        if (!decisions) {
            logger.log("cancelling command approval: no complete decision set", {itemId: params.itemId});
            return {decision: "cancel"};
        }
        try {
            const response = await this.client.requestPermission({
                title: params.networkApprovalContext ? NETWORK_TITLE : COMMAND_TITLE,
                description: nonBlank(params.reason),
                subject: {type: "tool_call", toolCall: commandSubject(approvalParams)},
                options: decisions.map(({option}) => option),
            }, this.signal());
            return {decision: selectedDecision(response, decisions) ?? "cancel"};
        } catch (error) {
            logger.error("command approval failed", error, {itemId: params.itemId});
            return {decision: "cancel"};
        }
    }

    async handleFileChange(params: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse> {
        const decisions = fileChangeDecisionOptions();
        try {
            const response = await this.client.requestPermission({
                title: FILE_CHANGE_TITLE,
                description: nonBlank(params.reason),
                subject: {type: "tool_call", toolCall: fileChangeSubject(params, this.turn.fileChange(params.itemId))},
                options: decisions.map(({option}) => option),
            }, this.signal());
            return {decision: selectedDecision(response, decisions) ?? "cancel"};
        } catch (error) {
            logger.error("file change approval failed", error, {itemId: params.itemId});
            return {decision: "cancel"};
        }
    }

    async handlePermissionsRequest(params: PermissionsRequestApprovalParams): Promise<PermissionsRequestApprovalResponse> {
        try {
            const response = await this.client.requestPermission({
                title: PERMISSIONS_TITLE,
                description: nonBlank(params.reason),
                subject: {type: "tool_call", toolCall: permissionsSubject(params.itemId, params.cwd, params.environmentId, params.permissions)},
                options: permissionProfileOptions(),
            }, this.signal());
            return permissionsResponse(params.permissions, response);
        } catch (error) {
            logger.error("permissions approval failed", error, {itemId: params.itemId});
            return rejected();
        }
    }
}

function permissionsResponse(permissions: RequestPermissionProfile, response: acp.RequestPermissionResponse): PermissionsRequestApprovalResponse {
    if (response.outcome.outcome !== "selected") return rejected();
    switch ((response.outcome as {optionId?: unknown}).optionId) {
        case OptionId.AllowPermissionsForTurn:
            return {permissions: granted(permissions), scope: "turn", strictAutoReview: false};
        case OptionId.AllowPermissionsForTurnStrict:
            return {permissions: granted(permissions), scope: "turn", strictAutoReview: true};
        case OptionId.AllowPermissionsForSession:
            return {permissions: granted(permissions), scope: "session", strictAutoReview: false};
        default:
            return rejected();
    }
}

function granted(permissions: RequestPermissionProfile): GrantedPermissionProfile {
    return {
        ...(permissions.network ? {network: permissions.network} : {}),
        ...(permissions.fileSystem ? {fileSystem: permissions.fileSystem} : {}),
    };
}

function rejected(): PermissionsRequestApprovalResponse {
    return {permissions: {}, scope: "turn", strictAutoReview: false};
}

function nonBlank(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}
