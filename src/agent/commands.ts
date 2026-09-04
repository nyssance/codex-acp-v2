import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {RateLimitSnapshot, ReviewTarget, SkillsListEntry, TurnCompletedNotification} from "../app-server/v2";
import type {AppServerClient} from "../codex/AppServerClient";
import {COLLABORATION_MODE_CONFIG_ID, DEFAULT_COLLABORATION_MODE, PLAN_COLLABORATION_MODE} from "../codex/models";
import {formatTokenCount} from "../util/tokens";
import type {Session} from "./session";

export type ParsedCommand = {name: string; rest: string};

export type CommandOutcome =
    | {kind: "prompt"}
    | {kind: "message"; text: string}
    | {kind: "config"; configId: string; value: string}
    | {kind: "compact"}
    | {kind: "review"; target: ReviewTarget}
    | {kind: "logout"};

export type CommandTurn = {turnCompleted: TurnCompletedNotification};

/** Slash commands handled by the adapter; anything else is sent to Codex verbatim. */
export const BUILTIN_COMMANDS: acp.AvailableCommand[] = [
    {name: "plan", description: "Toggle plan mode: Codex proposes a plan before making changes"},
    {name: "review", description: "Review uncommitted changes, or review with custom instructions", input: {type: "text", hint: "optional review instructions"}},
    {name: "review-branch", description: "Review changes relative to a base branch", input: {type: "text", hint: "branch name"}},
    {name: "review-commit", description: "Review a specific commit", input: {type: "text", hint: "commit sha"}},
    {name: "compact", description: "Summarize the conversation to free up context"},
    {name: "status", description: "Show session configuration, token usage, and rate limits"},
    {name: "mcp", description: "List configured Model Context Protocol (MCP) servers"},
    {name: "skills", description: "List available skills"},
    {name: "logout", description: "Sign out of the Codex account"},
];

export function parseCommand(prompt: readonly acp.ContentBlock[]): ParsedCommand | null {
    const first = prompt[0];
    if (!first || first.type !== "text") return null;
    const text = (first as {text: string}).text.trim();
    if (!text.startsWith("/")) return null;
    const body = text.slice(1).trim();
    const [name] = body.split(/\s+/);
    if (!name || name.startsWith("$")) return null;
    return {name: name.toLowerCase(), rest: body.slice(name.length).trim()};
}

export function resolveCommand(command: ParsedCommand, session: Session): CommandOutcome {
    switch (command.name) {
        case "plan":
            return {
                kind: "config",
                configId: COLLABORATION_MODE_CONFIG_ID,
                value: session.collaborationMode === PLAN_COLLABORATION_MODE ? DEFAULT_COLLABORATION_MODE : PLAN_COLLABORATION_MODE,
            };
        case "compact":
            return {kind: "compact"};
        case "review":
            return {kind: "review", target: command.rest.length > 0 ? {type: "custom", instructions: command.rest} : {type: "uncommittedChanges"}};
        case "review-branch":
            return command.rest.length > 0
                ? {kind: "review", target: {type: "baseBranch", branch: command.rest}}
                : {kind: "message", text: usage("review-branch", "<branch name>")};
        case "review-commit":
            return command.rest.length > 0
                ? {kind: "review", target: {type: "commit", sha: command.rest, title: null}}
                : {kind: "message", text: usage("review-commit", "<commit sha>")};
        case "logout":
            return {kind: "logout"};
        case "status":
        case "mcp":
        case "skills":
            return {kind: "message", text: ""};
        default:
            return {kind: "prompt"};
    }
}

function usage(name: string, hint: string): string {
    return `Usage: /${name} ${hint}`;
}

export function availableCommands(skills: readonly SkillsListEntry[]): acp.AvailableCommand[] {
    const commands = new Map<string, acp.AvailableCommand>();
    for (const builtin of BUILTIN_COMMANDS) commands.set(builtin.name, builtin);
    for (const entry of skills) {
        for (const skill of entry.skills) {
            const name = `$${skill.name}`;
            if (commands.has(name)) continue;
            commands.set(name, {name, description: skill.shortDescription || skill.description || skill.name});
        }
    }
    return [...commands.values()];
}

export function skillsMessage(skills: readonly SkillsListEntry[]): string {
    const lines = skills.flatMap(entry => entry.skills).map(skill => {
        const description = skill.shortDescription || skill.description;
        return description ? `- ${skill.name}: ${description}` : `- ${skill.name}`;
    });
    return lines.length > 0 ? ["Available skills:", ...lines].join("\n") : "No skills configured.";
}

export async function mcpMessage(codex: AppServerClient, session: Session): Promise<string> {
    const servers = await codex.mcpServerStatusList({});
    const lines = servers.data.map(server => {
        const tools = Object.keys(server.tools ?? {}).length;
        const resources = (server.resources ?? []).length;
        return `- ${server.name}: ${tools} tools, ${resources} resources, auth=${server.authStatus}`;
    });
    const sessionLines = session.mcpServerNames.map(name => `- ${name}`);
    return [
        lines.length > 0 ? "Configured MCP servers:" : "No MCP servers configured.",
        ...lines,
        ...(sessionLines.length > 0 ? ["", "Session MCP servers:", ...sessionLines] : []),
    ].join("\n");
}

export function statusMessage(session: Session, rateLimits: ReadonlyMap<string, RateLimitSnapshot>): string {
    const usage = session.lastUsage;
    const lines = [
        "**Session**",
        `**Session ID:** ${session.id}`,
        `**Working directory:** ${session.cwd}`,
        `**Model:** ${session.model.model} (${session.model.effort})`,
        `**Mode:** ${session.mode.name}`,
        `**Collaboration:** ${session.collaborationMode}`,
        `**Fast mode:** ${session.fastMode ? "on" : "off"}`,
        `**Account:** ${accountInfo(session)}`,
        "",
        "**Usage**",
        `**Last turn:** ${usage
            ? `${formatTokenCount(usage.totalTokens)} total (${formatTokenCount(usage.inputTokens)} input + ${formatTokenCount(usage.cachedInputTokens)} cached, ${formatTokenCount(usage.outputTokens)} output)`
            : "not available yet"}`,
        `**Context window:** ${usage && session.contextWindow
            ? `${Math.round(((session.contextWindow - usage.totalTokens) / session.contextWindow) * 100)}% left (${formatTokenCount(usage.totalTokens)} / ${formatTokenCount(session.contextWindow)})`
            : "not available yet"}`,
        ...rateLimitLines(rateLimits),
    ];
    return lines.join("  \n");
}

function accountInfo(session: Session): string {
    const account = session.account;
    if (!account) return "not logged in";
    switch (account.type) {
        case "apiKey":
            return "API key";
        case "chatgpt":
            return `ChatGPT ${account.planType}${account.email ? ` (${account.email})` : ""}`;
        case "amazonBedrock":
            return "Amazon Bedrock";
    }
}

function rateLimitLines(rateLimits: ReadonlyMap<string, RateLimitSnapshot>): string[] {
    const lines: string[] = [];
    for (const snapshot of rateLimits.values()) {
        const prefix = snapshot.limitName ? `${snapshot.limitName} ` : "";
        for (const window of [snapshot.primary, snapshot.secondary]) {
            if (!window) continue;
            const label = windowLabel(window.windowDurationMins);
            const reset = window.resetsAt === null ? "" : ` (resets ${new Date(window.resetsAt * 1000).toLocaleString()})`;
            lines.push(`**${prefix}${label}:** ${Math.round(100 - window.usedPercent)}% left${reset}`);
        }
        if (snapshot.credits?.unlimited) lines.push(`**${prefix}Credits:** unlimited`);
        else if (snapshot.credits?.balance) lines.push(`**${prefix}Credits:** ${snapshot.credits.balance}`);
    }
    return lines.length > 0 ? lines : ["**Limits:** not available yet"];
}

function windowLabel(minutes: number | null): string {
    if (minutes === null) return "Limit";
    if (minutes < 60) return `${minutes}m limit`;
    if (minutes < 1440) return `${Math.round(minutes / 60)}h limit`;
    if (minutes < 10080) return `${Math.round(minutes / 1440)}d limit`;
    return "Weekly limit";
}
