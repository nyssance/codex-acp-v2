import type {
    AdditionalPermissionProfile,
    CommandExecutionApprovalDecision,
    CommandExecutionRequestApprovalParams,
    NetworkPolicyAmendment,
} from "../app-server/v2";
import {isRecord} from "./json";

/** Newer app-servers advertise the decision set; older ones rely on the native fallback. */
export type CommandApprovalParams = CommandExecutionRequestApprovalParams & {
    additionalPermissions?: AdditionalPermissionProfile | null;
    availableDecisions?: unknown;
};

/**
 * Returns the ordered decisions the user may pick for a command approval, or
 * undefined when the advertised set is malformed. A malformed set fails closed:
 * the adapter never invents choices Codex did not offer.
 */
export function availableCommandDecisions(params: CommandApprovalParams): CommandExecutionApprovalDecision[] | undefined {
    if (params.availableDecisions === undefined || params.availableDecisions === null) {
        return defaultDecisions(params);
    }
    if (!Array.isArray(params.availableDecisions) || params.availableDecisions.length === 0) return undefined;
    const decisions: CommandExecutionApprovalDecision[] = [];
    for (const candidate of params.availableDecisions) {
        const decision = parseDecision(candidate, params);
        if (!decision) return undefined;
        decisions.push(decision);
    }
    return decisions;
}

function defaultDecisions(params: CommandApprovalParams): CommandExecutionApprovalDecision[] {
    if (params.networkApprovalContext) {
        const decisions: CommandExecutionApprovalDecision[] = ["accept", "acceptForSession"];
        for (const amendment of params.proposedNetworkPolicyAmendments ?? []) {
            decisions.push({applyNetworkPolicyAmendment: {network_policy_amendment: amendment}});
        }
        decisions.push("decline", "cancel");
        return decisions;
    }
    if (params.additionalPermissions) return ["accept", "cancel"];
    const decisions: CommandExecutionApprovalDecision[] = ["accept", "acceptForSession"];
    if (params.proposedExecpolicyAmendment && params.proposedExecpolicyAmendment.length > 0) {
        decisions.push({acceptWithExecpolicyAmendment: {execpolicy_amendment: params.proposedExecpolicyAmendment}});
    }
    decisions.push("decline", "cancel");
    return decisions;
}

function parseDecision(candidate: unknown, params: CommandExecutionRequestApprovalParams): CommandExecutionApprovalDecision | undefined {
    if (candidate === "accept" || candidate === "acceptForSession" || candidate === "decline" || candidate === "cancel") {
        return candidate;
    }
    if (!isRecord(candidate)) return undefined;
    if ("acceptWithExecpolicyAmendment" in candidate) {
        const value = candidate["acceptWithExecpolicyAmendment"];
        if (!isRecord(value)) return undefined;
        const amendment = value["execpolicy_amendment"];
        if (!isStringArray(amendment) || amendment.length === 0) return undefined;
        if (!sameStrings(amendment, params.proposedExecpolicyAmendment)) return undefined;
        return {acceptWithExecpolicyAmendment: {execpolicy_amendment: [...amendment]}};
    }
    if ("applyNetworkPolicyAmendment" in candidate) {
        const value = candidate["applyNetworkPolicyAmendment"];
        if (!isRecord(value)) return undefined;
        const amendment = parseNetworkAmendment(value["network_policy_amendment"]);
        if (!amendment || !params.networkApprovalContext) return undefined;
        if (amendment.host !== params.networkApprovalContext.host) return undefined;
        const proposed = params.proposedNetworkPolicyAmendments ?? [];
        if (!proposed.some(entry => entry.host === amendment.host && entry.action === amendment.action)) return undefined;
        return {applyNetworkPolicyAmendment: {network_policy_amendment: amendment}};
    }
    return undefined;
}

function parseNetworkAmendment(value: unknown): NetworkPolicyAmendment | undefined {
    if (!isRecord(value) || typeof value["host"] !== "string") return undefined;
    const action = value["action"];
    if (action !== "allow" && action !== "deny") return undefined;
    return {host: value["host"], action};
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

function sameStrings(left: readonly string[], right?: readonly string[] | null): boolean {
    return !!right && left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Renders an exec-policy prefix the way the Codex TUI does, unwrapping `bash -lc` scripts. */
export function renderExecPolicyPrefix(command: readonly string[]): string {
    const script = extractWrappedScript(command);
    if (script !== undefined) return script;
    if (command.some(value => value.includes("\0"))) return command.join(" ");
    return command.map(shlexQuote).join(" ");
}

function extractWrappedScript(command: readonly string[]): string | undefined {
    const executable = executableName(command[0]);
    if ((executable === "bash" || executable === "zsh" || executable === "sh")
        && command.length === 3
        && (command[1] === "-lc" || command[1] === "-c")) {
        return command[2];
    }
    if (executable !== "pwsh" && executable !== "powershell") return undefined;
    const allowedFlags = new Set(["-nologo", "-noprofile", "-command", "-c"]);
    for (let index = 1; index + 1 < command.length; index++) {
        const flag = command[index]?.toLowerCase();
        if (flag === undefined || !allowedFlags.has(flag)) return undefined;
        if (flag === "-command" || flag === "-c") return command[index + 1];
    }
    return undefined;
}

function executableName(command: string | undefined): string | undefined {
    let filename = command?.replaceAll("\\", "/").split("/").at(-1);
    while (filename !== undefined) {
        if (["bash", "zsh", "sh", "pwsh", "powershell"].includes(filename)) return filename;
        const dot = filename.lastIndexOf(".");
        if (dot <= 0) return undefined;
        filename = filename.slice(0, dot);
    }
    return undefined;
}

function shlexQuote(value: string): string {
    if (value.length === 0) return "''";
    if (/^[0-9A-Za-z+\-./:@_]+$/.test(value)) return value;
    if (!value.includes("'")) return `'${value}'`;
    return `"${value.replace(/["\\$`!]/g, "\\$&")}"`;
}
