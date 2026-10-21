import { describe, expect, it } from "bun:test"

import { compatibleResponsesRequest } from "../codex/responsesCompatibility"

describe("native Responses history compatibility", () => {
  it("omits foreign plaintext reasoning even when it has encrypted content, preserving tool pairs and native reasoning", () => {
    const items = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      {
        type: "reasoning",
        summary: [],
        content: [{ type: "reasoning_text", text: "foreign" }],
        encrypted_content: "foreign-token"
      },
      { type: "reasoning", summary: [], content: [{ type: "text", text: "plaintext" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "native" }], encrypted_content: "native-token" },
      { type: "reasoning", content: [], encrypted_content: "native-token-2" },
      { type: "function_call", call_id: "call", name: "tool", arguments: "{}" },
      { type: "function_call_output", call_id: "call", output: "result" }
    ]
    const raw = JSON.stringify({
      type: "response.create",
      model: "gpt-test",
      previous_response_id: "previous",
      input: items
    })
    const output = compatibleResponsesRequest(raw)
    expect(JSON.parse(output)).toEqual({
      type: "response.create",
      model: "gpt-test",
      previous_response_id: "previous",
      input: [items[0], items[3], items[4], items[5], items[6]]
    })
    expect((JSON.parse(raw) as { input: unknown[] }).input).toHaveLength(7)
    expect(compatibleResponsesRequest(output)).toBe(output)
  })
  it("preserves requests without incompatible input byte for byte", () => {
    for (const raw of ['{ "type": "response.cancel" }', '{ "input": [] }', '{"input":"hello"}'])
      expect(compatibleResponsesRequest(raw)).toBe(raw)
  })
  it("rejects malformed JSON rather than forwarding an unexamined request", () => {
    expect(() => compatibleResponsesRequest("not json")).toThrow()
  })
})
