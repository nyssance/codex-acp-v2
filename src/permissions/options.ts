import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {CommandExecutionApprovalDecision, FileChangeApprovalDecision} from "../app-server/v2";
import {availableCommandDecisions, renderExecPolicyPrefix, type CommandApprovalParams} from "./commandDecisions";

export const OptionId = {
    AllowOnce: "allow_once",
    AllowForSession: "allow_for_session",
    Decline: "decline",
    Cancel: "cancel",
    AcceptWithExecpolicyAmendment: "accept_execpolicy_amendment",
    ApplyNetworkPolicyAmendment: "apply_network_policy_amendment",
    AllowPermissionsForTurn: "allow_permissions_turn",
    AllowPermissionsForTurnStrict: "allow_permissions_turn_strict_auto_review",
    AllowPermissionsForSession: "allow_permissions_session",
    RejectPermissions: "reject_permissions",
} as const;

export type DecisionOption<T> = {option: acp.PermissionOption; decision: T};

export function commandDecisionOptions(params: CommandApprovalParams): DecisionOption<CommandExecutionApprovalDecision>[] | undefined {
    const decisions = availableCommandDecisions(params);
    if (!decisions) return undefined;
    const options: DecisionOption<CommandExecutionApprovalDecision>[] = [];
    let networkIndex = 0;
    for (const decision of decisions) {
        if (decision === "accept") {
            options.push(decisionOption(OptionId.AllowOnce, params.networkApprovalContext ? "Yes, just this once" : "Yes, proceed", "allow_once", decision));
        } else if (decision === "acceptForSession") {
            const name = params.networkApprovalContext
                ? "Yes, and allow this host for this conversation"
                : params.additionalPermissions
                    ? "Yes, and allow these permissions for this session"
                    : "Yes, and don't ask again for this command in this session";
            options.push(decisionOption(OptionId.AllowForSession, name, "allow_always", decision));
        } else if (decision === "decline") {
            options.push(decisionOption(OptionId.Decline, "No, continue without running it", "reject_once", decision));
        } else if (decision === "cancel") {
            options.push(decisionOption(OptionId.Cancel, "No, and tell Codex what to do differently", "reject_once", decision));
        } else if ("acceptWithExecpolicyAmendment" in decision) {
            const prefix = renderExecPolicyPrefix(decision.acceptWithExecpolicyAmendment.execpolicy_amendment);
            if (prefix.includes("\n") || prefix.includes("\r")) continue;
            options.push(decisionOption(
                OptionId.AcceptWithExecpolicyAmendment,
                `Yes, and don't ask again for commands that start with \`${prefix}\``,
                "allow_always",
                decision,
            ));
        } else {
            const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
            options.push(decisionOption(
                `${OptionId.ApplyNetworkPolicyAmendment}:${networkIndex++}`,
                amendment.action === "allow" ? "Yes, and allow this host in the future" : "No, and block this host in the future",
                amendment.action === "allow" ? "allow_always" : "reject_always",
                decision,
            ));
        }
    }
    const ordered = [...options].sort((left, right) => order(left.option) - order(right.option));
    const hasAllow = ordered.some(({option}) => option.kind === "allow_once" || option.kind === "allow_always");
    const hasReject = ordered.some(({option}) => option.kind === "reject_once" || option.kind === "reject_always");
    const ids = ordered.map(({option}) => option.optionId);
    return hasAllow && hasReject && new Set(ids).size === ids.length ? ordered : undefined;
}

function order(option: acp.PermissionOption): number {
    if (option.kind === "allow_once") return 0;
    if (option.kind === "allow_always") return 1;
    return 2;
}

export function fileChangeDecisionOptions(): DecisionOption<FileChangeApprovalDecision>[] {
    return [
        decisionOption(OptionId.AllowOnce, "Yes, proceed", "allow_once", "accept"),
        decisionOption(OptionId.AllowForSession, "Yes, and don't ask again for these files", "allow_always", "acceptForSession"),
        decisionOption(OptionId.Cancel, "No, and tell Codex what to do differently", "reject_once", "cancel"),
    ];
}

export function permissionProfileOptions(): acp.PermissionOption[] {
    return [
        permissionOption(OptionId.AllowPermissionsForTurn, "Yes, grant these permissions for this turn", "allow_once"),
        permissionOption(OptionId.AllowPermissionsForTurnStrict, "Yes, grant for this turn with strict auto review", "allow_once"),
        permissionOption(OptionId.AllowPermissionsForSession, "Yes, grant these permissions for this session", "allow_always"),
        permissionOption(OptionId.RejectPermissions, "No, continue without permissions", "reject_once"),
    ];
}

function decisionOption<T>(optionId: string, name: string, kind: acp.PermissionOptionKind, decision: T): DecisionOption<T> {
    return {option: permissionOption(optionId, name, kind), decision};
}

export function permissionOption(optionId: string, name: string, kind: acp.PermissionOptionKind, description?: string): acp.PermissionOption {
    return {optionId, name, kind, ...(description ? {_meta: {codex: {description}}} : {})};
}

export function selectedDecision<T>(response: acp.RequestPermissionResponse, decisions: readonly DecisionOption<T>[]): T | undefined {
    if (response.outcome.outcome !== "selected") return undefined;
    const optionId = (response.outcome as {optionId?: unknown}).optionId;
    return decisions.find(({option}) => option.optionId === optionId)?.decision;
}
