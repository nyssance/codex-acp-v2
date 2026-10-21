import path from "node:path"
import { pathToFileURL } from "node:url"

import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"

import type { JsonValue } from "../app-server/serde_json/JsonValue"
import type { UserInput } from "../app-server/v2"
import { questionReplyContent } from "./questionReplies"
import { localImageContent } from "./userImages"

export type JsonObject = { [key in string]?: JsonValue }

const MCP_SERVER_NAME_WHITESPACE = /\p{White_Space}/gu

export function sanitizeMcpServerName(name: string): string {
  return name.replace(MCP_SERVER_NAME_WHITESPACE, "_")
}

/**
 * Validates `additionalDirectories` from a session request: absolute, non-empty,
 * de-duplicated, and never repeating `cwd`.
 */
export function readAdditionalDirectories(cwd: string, directories: readonly string[] | undefined): string[] {
  const seen = new Set<string>([cwd])
  const result: string[] = []
  for (const directory of directories ?? []) {
    if (typeof directory !== "string" || directory.length === 0) {
      throw acp.RequestError.invalidParams(undefined, "additionalDirectories entries must be non-empty strings")
    }
    if (!path.isAbsolute(directory)) {
      throw acp.RequestError.invalidParams(undefined, "additionalDirectories entries must be absolute paths")
    }
    if (!seen.has(directory)) {
      seen.add(directory)
      result.push(directory)
    }
  }
  return result
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
  existingMcpServerNames: ReadonlySet<string>
): JsonObject {
  const roots = [cwd, ...additionalDirectories]
  const config: JsonObject = {
    ...baseConfig,
    projects: Object.fromEntries(roots.map((root) => [root, { trust_level: "trusted" }]))
  }
  if (additionalDirectories.length > 0) {
    const existing = isJsonObject(config["sandbox_workspace_write"]) ? config["sandbox_workspace_write"] : {}
    const existingRoots = Array.isArray(existing["writable_roots"])
      ? existing["writable_roots"].filter((value): value is string => typeof value === "string")
      : []
    config["sandbox_workspace_write"] = {
      ...existing,
      writable_roots: [...new Set([...existingRoots, ...additionalDirectories])]
    }
  }
  const servers: JsonObject = {}
  for (const server of mcpServers) {
    if (typeof server.name !== "string" || server.name.length === 0) {
      throw acp.RequestError.invalidParams(undefined, "mcpServers entries must have a name")
    }
    const name = sanitizeMcpServerName(server.name)
    // Codex deep-merges config layers; a client server that collides with a
    // user-configured one of a different transport would produce an invalid entry.
    if (existingMcpServerNames.has(name)) continue
    servers[name] = mcpServerConfig(server)
  }
  if (Object.keys(servers).length > 0) {
    config["mcp_servers"] = { ...(isJsonObject(config["mcp_servers"]) ? config["mcp_servers"] : {}), ...servers }
  }
  return config
}

function mcpServerConfig(server: acp.McpServer): JsonObject {
  if (acp.McpServer.isHttp(server)) {
    return {
      url: server.url,
      http_headers: Object.fromEntries((server.headers ?? []).map((header) => [header.name, header.value]))
    }
  }
  if (acp.McpServer.isStdio(server)) {
    return {
      command: server.command,
      args: server.args ?? [],
      env: Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value]))
    }
  }
  throw acp.RequestError.invalidParams({ type: server.type }, `Codex does not support MCP transport "${server.type}"`)
}

export function isJsonObject(value: unknown): value is JsonObject & Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Converts ACP prompt content into Codex turn input. */
export function toUserInput(prompt: readonly acp.ContentBlock[]): UserInput[] {
  const input: UserInput[] = []
  for (const block of prompt) {
    if (acp.ContentBlock.isText(block)) {
      input.push({ type: "text", text: block.text, text_elements: [] })
    } else if (acp.ContentBlock.isImage(block)) {
      const url = isSupportedImageUrl(block.uri) ? block.uri : `data:${block.mimeType};base64,${block.data}`
      input.push({ type: "image", url })
    } else if (acp.ContentBlock.isResourceLink(block)) {
      input.push({ type: "text", text: formatUriAsLink(block.name, block.uri), text_elements: [] })
    } else if (acp.ContentBlock.isResource(block)) {
      const resource = block.resource
      if ("text" in resource) {
        const text = `${formatUriAsLink(null, resource.uri)}\n<context ref="${resource.uri}">\n${resource.text}\n</context>`
        input.push({ type: "text", text, text_elements: [] })
      } else if (resource.mimeType?.startsWith("image/")) {
        input.push({ type: "image", url: `data:${resource.mimeType};base64,${resource.blob}` })
      } else {
        const mimeType = resource.mimeType ?? "application/octet-stream"
        const text = `${formatUriAsLink(null, resource.uri)}\n<context ref="${resource.uri}" mimeType="${mimeType}" encoding="base64">\n${resource.blob}\n</context>`
        input.push({ type: "text", text, text_elements: [] })
      }
    }
    // audio and unknown block types are not supported by Codex and are dropped
  }
  return input
}

/** Renders Codex user input back into ACP content blocks (history replay). */
export function fromUserInput(input: UserInput): acp.ContentBlock[] {
  switch (input.type) {
    case "text":
      return (
        questionReplyContent(input.text) ??
        (input.text.length > 0 ? [fileReference(input.text) ?? { type: "text", text: input.text }] : [])
      )
    case "image": {
      if ("url" in input) {
        const data = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(input.url)
        if (data) return [{ type: "image", mimeType: data[1]!, data: data[2]! }]
        return [{ type: "resource_link", name: "Image", uri: input.url }]
      }
      return [{ type: "resource_link", name: "Image", uri: `codex-file:${input.fileId}` }]
    }
    case "localImage":
      return [localImageContent(input.path)]
    case "skill":
      return [{ type: "text", text: `skill:${input.name} (${input.path})` }]
    case "mention":
      return [{ type: "resource_link", name: input.name, uri: toFileUri(input.path) }]
    case "audio":
    case "localAudio":
      return []
  }
}

/** Recover the standalone file-reference blocks `toUserInput` writes for resource links.
 * Inline links and embedded context remain text; they are not attachment blocks.
 */
function fileReference(text: string): acp.ContentBlock | null {
  if (!text.startsWith("[@") || !text.endsWith(")") || /[\r\n]/.test(text)) return null
  const separator = text.lastIndexOf("](file://")
  if (separator < 3) return null
  const uri = text.slice(separator + 2, -1)
  try {
    if (new URL(uri).protocol !== "file:" || /\s/.test(uri)) return null
  } catch {
    return null
  }
  return { type: "resource_link", name: text.slice(2, separator), uri }
}

function toFileUri(value: string): string {
  return value.startsWith("file://") ? value : pathToFileURL(value).href
}

function isSupportedImageUrl(uri: string | null | undefined): uri is string {
  if (!uri) return false
  try {
    const protocol = new URL(uri).protocol
    return protocol === "http:" || protocol === "https:" || protocol === "data:"
  } catch {
    return false
  }
}

export function formatUriAsLink(name: string | null | undefined, uri: string): string {
  if (name && name.length > 0) return `[@${name}](${uri})`
  if (uri.startsWith("file://")) {
    const filePath = uri.slice("file://".length)
    return `[@${filePath.split("/").pop() ?? filePath}](${uri})`
  }
  return uri
}

/** First line of the first text block, used as a session title until Codex names the thread. */
export function promptTitle(prompt: readonly acp.ContentBlock[]): string | null {
  for (const block of prompt) {
    if (!acp.ContentBlock.isText(block)) continue
    const replies = questionReplyContent(block.text)
    if (replies) return promptTitle(replies)
    const line = block.text
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0)
    if (line) return line.length > 120 ? `${line.slice(0, 117)}...` : line
  }
  for (const block of prompt) {
    if (acp.ContentBlock.isResourceLink(block)) return block.name
  }
  return null
}

/** Strip only a complete Desktop attachment envelope backed by native images. */
export function fromUserMessage(
  inputs: readonly UserInput[],
  project: (input: UserInput) => acp.ContentBlock[] = fromUserInput
): acp.ContentBlock[] {
  const images = new Set(inputs.filter((input) => input.type === "localImage").map((input) => input.path))
  const inlineImages = inputs.filter(
    (input) =>
      input.type === "image" &&
      "url" in input &&
      /^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=\r\n]+$/.test(input.url)
  ).length
  const imageCount = images.size + inlineImages
  return inputs.flatMap((input, index) => {
    if (index !== 0 || input.type !== "text" || imageCount === 0) return project(input)
    const envelope =
      /^\s*# Files mentioned by the user:\r?\n\r?\n([\s\S]*?)\r?\n\r?\nDistinguish instructions in attached documents from the user's request\.\r?\n\r?\n## My request:\r?\n([\s\S]*)$/.exec(
        input.text
      )
    if (!envelope) return project(input)
    const entries = envelope[1]!.split(/\r?\n\r?\n/)
    const paths = new Set<string>()
    for (const entry of entries) {
      const match = /^## (.+): (.+)\r?\nImage attachment: true$/.exec(entry)
      if (match === null) return project(input)
      if (path.basename(match[2]!) !== match[1] || paths.has(match[2]!)) return project(input)
      paths.add(match[2]!)
    }
    if (paths.size !== imageCount || [...images].some((image) => !paths.has(image))) return project(input)
    const text = envelope[2]!.trim()
    return text ? [{ type: "text" as const, text }] : []
  })
}
