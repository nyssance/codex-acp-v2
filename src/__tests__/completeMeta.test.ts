import {describe, expect, it} from "vitest";
import {CompleteMeta} from "../bridge/completeMeta";

describe("CompleteMeta", () => {
    it("completes a named top-level key from the entity's earlier frames and leaves unnamed keys unsent", () => {
        const ledger = new CompleteMeta();
        ledger.complete({sessionUpdate: "tool_call_update", toolCallId: "t", _meta: {codex: {turnId: "turn-1"}, board: {nodeIds: ["n1"]}}});
        const frame = ledger.complete({sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", _meta: {codex: {reconciled: true}}});
        expect(frame._meta).toEqual({codex: {turnId: "turn-1", reconciled: true}});
    });

    it("keeps entities apart and treats chunks as frames of their message", () => {
        const ledger = new CompleteMeta();
        ledger.complete({sessionUpdate: "agent_message_chunk", messageId: "m1", content: {type: "text", text: "a"}, _meta: {codex: {turnId: "turn-1"}}});
        ledger.complete({sessionUpdate: "agent_message_chunk", messageId: "m2", content: {type: "text", text: "b"}, _meta: {codex: {turnId: "turn-2"}}});
        const frame = ledger.complete({sessionUpdate: "agent_message", messageId: "m1", _meta: {codex: {phase: "final_answer"}}});
        expect(frame._meta).toEqual({codex: {turnId: "turn-1", phase: "final_answer"}});
    });

    it("forgets a key set to null and the whole entity on _meta null; a later value replaces a non-object whole", () => {
        const ledger = new CompleteMeta();
        ledger.complete({sessionUpdate: "terminal_update", terminalId: "x", _meta: {codex: {a: 1}, other: 5}});
        expect(ledger.complete({sessionUpdate: "terminal_update", terminalId: "x", _meta: {codex: null, other: {b: 2}}})._meta)
            .toEqual({codex: null, other: {b: 2}});
        expect(ledger.complete({sessionUpdate: "terminal_update", terminalId: "x", _meta: {codex: {c: 3}}})._meta).toEqual({codex: {c: 3}});
        ledger.complete({sessionUpdate: "terminal_update", terminalId: "x", _meta: null});
        expect(ledger.complete({sessionUpdate: "terminal_update", terminalId: "x", _meta: {codex: {d: 4}}})._meta).toEqual({codex: {d: 4}});
    });

    it("passes frames without entity metadata through untouched", () => {
        const ledger = new CompleteMeta();
        const usage = {sessionUpdate: "usage_update", used: 1, size: 2, _meta: {codex: {x: 1}}} as const;
        expect(ledger.complete(usage as never)).toBe(usage);
        const plain = {sessionUpdate: "tool_call_update", toolCallId: "t"} as const;
        expect(ledger.complete(plain)).toBe(plain);
    });
});
