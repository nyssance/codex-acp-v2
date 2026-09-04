import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {ApprovalsReviewer, AskForApproval, SandboxMode, SandboxPolicy} from "../app-server/v2";

export const MODE_CONFIG_ID = "mode";

export type AgentModeId = "read-only" | "agent" | "agent-full-access";

/** Approval and sandbox preset, exposed to clients as the `mode` config option. */
export interface AgentMode {
    readonly id: AgentModeId;
    readonly name: string;
    readonly description: string;
    readonly approvalPolicy: AskForApproval;
    readonly approvalsReviewer: ApprovalsReviewer;
    readonly sandboxPolicy: SandboxPolicy;
    readonly sandboxMode: SandboxMode;
}

const workspaceWrite: SandboxPolicy = {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
};

export const AGENT_MODES: readonly AgentMode[] = [
    {
        id: "read-only",
        name: "Ask for approval",
        description: "Always ask to edit external files and use the internet",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: workspaceWrite,
        sandboxMode: "workspace-write",
    },
    {
        id: "agent",
        name: "Approve for me",
        description: "Only ask for actions detected as potentially unsafe",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: workspaceWrite,
        sandboxMode: "workspace-write",
    },
    {
        id: "agent-full-access",
        name: "Full access",
        description: "Unrestricted access to the internet and any file on your computer",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: {type: "dangerFullAccess"},
        sandboxMode: "danger-full-access",
    },
];

export const DEFAULT_AGENT_MODE: AgentMode = AGENT_MODES[1]!;

export function findAgentMode(id: string): AgentMode | undefined {
    return AGENT_MODES.find(mode => mode.id === id);
}

export function initialAgentMode(env: NodeJS.ProcessEnv = process.env): AgentMode {
    const requested = env["INITIAL_AGENT_MODE"];
    return (requested && findAgentMode(requested)) || DEFAULT_AGENT_MODE;
}

export function modeConfigOption(current: AgentMode): acp.SessionConfigOption {
    return {
        configId: MODE_CONFIG_ID,
        name: "Mode",
        description: "Approval and sandboxing preset for the session",
        category: "mode",
        type: "select",
        currentValue: current.id,
        options: AGENT_MODES.map(mode => ({
            value: mode.id,
            name: mode.name,
            description: mode.description,
        })),
    };
}

/** Adds extra workspace roots to a workspace-write sandbox so Codex can edit them. */
export function withWritableRoots(policy: SandboxPolicy, roots: readonly string[]): SandboxPolicy {
    if (roots.length === 0 || policy.type !== "workspaceWrite") return policy;
    return {...policy, writableRoots: [...new Set([...policy.writableRoots, ...roots])]};
}
