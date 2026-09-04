import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import path from "node:path";
import type {JsonValue} from "../app-server/serde_json/JsonValue";
import type {UserInput} from "../app-server/v2";

export type JsonObject = {[key in string]?: JsonValue};

const MCP_SERVER_NAME_WHITESPACE = /\p{White_Space}/gu;

export function sanitizeMcpServerName(name: string): string {
    return name.replace(MCP_SERVER_NAME_WHITESPACE, "_");
}

/**
 * Validates `additionalDirectories` from a session request: absolute, non-empty,
 * de-duplicated, and never repeating `cwd`.
 */
export function readAdditionalDirectories(cwd: string, directories: readonly string[] | undefined): string[] {
    const seen = new Set<string>([cwd]);
    const result: string[] = [];
    for (const directory of directories ?? []) {
        if (typeof directory !== "string" || directory.length === 0) {
            throw acp.RequestError.invalidParams(undefined, "additionalDirectories entries must be non-empty strings");
        }
        if (!path.isAbsolute(directory)) {
            throw acp.RequestError.invalidParams(undefined, "additionalDirectories entries must be absolute paths");
        }
        if (!seen.has(directory)) {
            seen.add(directory);
            result.push(directory);
        }
    }
    return result;
}

/**
 * Builds the per-thread Codex config override: trusted project roots, extra
 * sandbox write roots, and client-supplied MCP servers layered over `baseConfig`.
 */
export function buildThreadConfig(
    baseConfig: JsonObject,
    cwd: string,
    additionalDirectories: readonly string[],
    mcpServers: readonly acp.McpServer[],
    existingMcpServerNames: ReadonlySet<string>,
): JsonObject {
    const roots = [cwd, ...additionalDirectories];
    const config: JsonObject = {
        ...baseConfig,
        projects: Object.fromEntries(roots.map(root => [root, {trust_level: "trusted"}])),
    };
    if (additionalDirectories.length > 0) {
        const existing = isJsonObject(config["sandbox_workspace_write"]) ? config["sandbox_workspace_write"] : {};
        const existingRoots = Array.isArray(existing["writable_roots"])
            ? existing["writable_roots"].filter((value): value is string => typeof value === "string")
            : [];
        config["sandbox_workspace_write"] = {
            ...existing,
            writable_roots: [...new Set([...existingRoots, ...additionalDirectories])],
        };
    }
    const servers: JsonObject = {};
    for (const server of mcpServers) {
        if (typeof server.name !== "string" || server.name.length === 0) {
            throw acp.RequestError.invalidParams(undefined, "mcpServers entries must have a name");
        }
        const name = sanitizeMcpServerName(server.name);
        // Codex deep-merges config layers; a client server that collides with a
        // user-configured one of a different transport would produce an invalid entry.
        if (existingMcpServerNames.has(name)) continue;
        servers[name] = mcpServerConfig(server);
    }
    if (Object.keys(servers).length > 0) {
        config["mcp_servers"] = {...(isJsonObject(config["mcp_servers"]) ? config["mcp_servers"] : {}), ...servers};
    }
    return config;
}

function mcpServerConfig(server: acp.McpServer): JsonObject {
    if (acp.McpServer.isHttp(server)) {
        return {
            url: server.url,
            http_headers: Object.fromEntries((server.headers ?? []).map(header => [header.name, header.value])),
        };
    }
    if (acp.McpServer.isStdio(server)) {
        return {
            command: server.command,
            args: server.args ?? [],
            env: Object.fromEntries((server.env ?? []).map(entry => [entry.name, entry.value])),
        };
    }
    throw acp.RequestError.invalidParams({type: server.type}, `Codex does not support MCP transport "${server.type}"`);
}

export function isJsonObject(value: unknown): value is JsonObject & Record<string, JsonValue> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Converts ACP prompt content into Codex turn input. */
export function toUserInput(prompt: readonly acp.ContentBlock[]): UserInput[] {
    const input: UserInput[] = [];
    for (const block of prompt) {
        if (acp.ContentBlock.isText(block)) {
            input.push({type: "text", text: block.text, text_elements: []});
        } else if (acp.ContentBlock.isImage(block)) {
            const url = isSupportedImageUrl(block.uri) ? block.uri : `data:${block.mimeType};base64,${block.data}`;
            input.push({type: "image", url});
        } else if (acp.ContentBlock.isResourceLink(block)) {
            input.push({type: "text", text: formatUriAsLink(block.name, block.uri), text_elements: []});
        } else if (acp.ContentBlock.isResource(block)) {
            const resource = block.resource;
            if ("text" in resource) {
                const text = `${formatUriAsLink(null, resource.uri)}\n<context ref="${resource.uri}">\n${resource.text}\n</context>`;
                input.push({type: "text", text, text_elements: []});
            } else if (resource.mimeType?.startsWith("image/")) {
                input.push({type: "image", url: `data:${resource.mimeType};base64,${resource.blob}`});
            } else {
                const mimeType = resource.mimeType ?? "application/octet-stream";
                const text = `${formatUriAsLink(null, resource.uri)}\n<context ref="${resource.uri}" mimeType="${mimeType}" encoding="base64">\n${resource.blob}\n</context>`;
                input.push({type: "text", text, text_elements: []});
            }
        }
        // audio and unknown block types are not supported by Codex and are dropped
    }
    return input;
}

/** Renders Codex user input back into ACP content blocks (history replay). */
export function fromUserInput(input: UserInput): acp.ContentBlock[] {
    switch (input.type) {
        case "text":
            return input.text.length > 0 ? [{type: "text", text: input.text}] : [];
        case "image":
            return [{type: "text", text: formatUriAsLink("image", input.url)}];
        case "localImage":
            return [{type: "text", text: formatUriAsLink(null, toFileUri(input.path))}];
        case "skill":
            return [{type: "text", text: `skill:${input.name} (${input.path})`}];
        case "mention":
            return [{type: "text", text: formatUriAsLink(input.name, toFileUri(input.path))}];
        case "audio":
        case "localAudio":
            return [];
    }
}

function toFileUri(value: string): string {
    return value.startsWith("file://") ? value : `file://${value}`;
}

function isSupportedImageUrl(uri: string | null | undefined): uri is string {
    if (!uri) return false;
    try {
        const protocol = new URL(uri).protocol;
        return protocol === "http:" || protocol === "https:" || protocol === "data:";
    } catch {
        return false;
    }
}

export function formatUriAsLink(name: string | null | undefined, uri: string): string {
    if (name && name.length > 0) return `[@${name}](${uri})`;
    if (uri.startsWith("file://")) {
        const filePath = uri.slice("file://".length);
        return `[@${filePath.split("/").pop() ?? filePath}](${uri})`;
    }
    return uri;
}

/** First line of the first text block, used as a session title until Codex names the thread. */
export function promptTitle(prompt: readonly acp.ContentBlock[]): string | null {
    for (const block of prompt) {
        if (!acp.ContentBlock.isText(block)) continue;
        const line = block.text.split(/\r?\n/).map(part => part.trim()).find(part => part.length > 0);
        if (line) return line.length > 120 ? `${line.slice(0, 117)}...` : line;
    }
    return null;
}
