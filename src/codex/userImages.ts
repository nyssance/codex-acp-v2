import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"

// Provenance is process-local: client-supplied metadata and ordinary links cannot
// authorize local reads. Only native localImage inputs create these references.
const nativeImages = new WeakMap<acp.ContentBlock, string>()
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

export function localImageContent(path: string): acp.ContentBlock {
  const block: acp.ContentBlock = {
    type: "resource_link",
    name: "Image",
    uri: path.startsWith("file:") ? path : pathToFileURL(path).href
  }
  nativeImages.set(block, path)
  return block
}

export async function hydrateUserImages(
  content: readonly acp.ContentBlock[],
  signal: AbortSignal
): Promise<acp.ContentBlock[]> {
  const result: acp.ContentBlock[] = []
  for (const block of content) {
    signal.throwIfAborted()
    const path = nativeImages.get(block)
    if (path === undefined) result.push(block)
    else {
      const image = await readImage(path)
      if (
        acp.ContentBlock.isResourceLink(block) &&
        block._meta &&
        (acp.ContentBlock.isImage(image) || acp.ContentBlock.isResourceLink(image))
      ) {
        const original = block._meta["codex"]
        const hydrated = image._meta?.["codex"]
        image._meta = {
          ...block._meta,
          ...image._meta,
          codex: {
            ...(original && typeof original === "object" ? original : {}),
            ...(hydrated && typeof hydrated === "object" ? hydrated : {})
          }
        }
      }
      result.push(image)
    }
  }
  signal.throwIfAborted()
  return result
}

async function readImage(path: string): Promise<acp.ContentBlock> {
  try {
    // Nonblocking open avoids hanging replay on a stale path replaced by a FIFO.
    const file = await open(
      path.startsWith("file:") ? fileURLToPath(path) : path,
      constants.O_RDONLY | constants.O_NONBLOCK
    )
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return unavailable()
      const data = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset)
        if (bytesRead === 0) return unavailable()
        offset += bytesRead
      }
      const mimeType = imageMimeType(data)
      return mimeType ? { type: "image", mimeType, data: data.toString("base64") } : unavailable()
    } finally {
      await file.close()
    }
  } catch {
    // Clipboard files can expire. A missing attachment must not hide the turn.
    return unavailable()
  }
}

function unavailable(): acp.ContentBlock {
  return {
    type: "resource_link",
    name: "Image unavailable",
    uri: "codex-image:unavailable",
    _meta: { codex: { imageUnavailable: true } }
  }
}

function imageMimeType(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg"
  if (/^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) return "image/gif"
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp"
  if (data.toString("ascii", 0, 2) === "BM") return "image/bmp"
  return null
}
