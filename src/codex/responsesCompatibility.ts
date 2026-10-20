import { isRecord } from "../permissions/json"

/** Native Responses rejects plaintext reasoning input, including foreign encrypted envelopes. */
export function compatibleResponsesRequest(body: string): string {
  const request: unknown = JSON.parse(body)
  if (!isRecord(request) || !Array.isArray(request["input"])) return body
  const input = request["input"]
  const compatible = input.filter(
    (item: unknown) =>
      !(isRecord(item) && item["type"] === "reasoning" && Array.isArray(item["content"]) && item["content"].length > 0)
  )
  return compatible.length === input.length ? body : JSON.stringify({ ...request, input: compatible })
}
