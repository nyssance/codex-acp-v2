import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {describe, expect, it} from "vitest";
import {createAgentApp} from "../agent/createAgent";
import {AppServerClient} from "../codex/AppServerClient";
import {CommandReceipts} from "../agent/commandReceipts";
import {createTestAgent, CWD, THREAD_ID, itemCompleted, threadResponse, turn, turnCompleted} from "./harness";
import {ProtocolOracle} from "./protocolOracle";

const nativeUser = {type: "userMessage" as const, id: "native-old", clientId: "old-receipt", content: [{type: "text" as const, text: "previous input", text_elements: []}]};
const nativeAgent = {type: "agentMessage" as const, id: "old-answer", text: "previous output", phase: "commentary" as const, memoryCitation: null, delivery: null, questions: null};
const nativeTool = {type: "commandExecution" as const, id: "old-tool", pluginId: null, scriptPath: null, command: "sleep 10", cwd: CWD, processId: null, source: "agent" as const,
    status: "inProgress" as const, commandActions: [], aggregatedOutput: "old output", exitCode: null, durationMs: null};

describe("resume history visibility", () => {
    it.each([undefined, null, {type: "start" as const}])("honors replayFrom %j on the official client wire", async replayFrom => {
        const t = createTestAgent();
        t.codex.respond("thread/resume", () => threadResponse({status: {type: "active", activeFlags: []}}));
        t.codex.respond("thread/turns/list", () => ({data: [turn({status: "inProgress", items: [nativeUser, nativeAgent, nativeTool]})], nextCursor: null, backwardsCursor: null}));
        const upstream = new TransformStream<Uint8Array, Uint8Array>();
        const downstream = new TransformStream<Uint8Array, Uint8Array>();
        const server = createAgentApp({codex: new AppServerClient(t.codex.asMessageConnection()), commandReceipts: new CommandReceipts(), info: {name: "audit", version: "1"}, env: {}})
            .connect(acp.ndJsonStream(downstream.writable, upstream.readable));
        const updates: acp.SessionUpdate[] = [];
        const oracle = new ProtocolOracle();
        const app = acp.client({name: "audit"}).onNotification("session/update", ({params}) => { updates.push(params.update); oracle.accept(params.sessionId, params.update); });
        try {
            await app.connectWith(acp.ndJsonStream(upstream.writable, downstream.readable), async client => {
                await client.request("initialize", {protocolVersion: 2, info: {name: "audit", version: "1"}});
                await client.request("session/resume", {sessionId: THREAD_ID, cwd: CWD, ...(replayFrom === undefined ? {} : {replayFrom})});
                const beforeResponse = [...updates];
                await t.settle();
                const history = (frames: acp.SessionUpdate[]) => frames.filter(frame => ["user_message", "agent_message", "tool_call_update", "terminal_update"].includes(frame.sessionUpdate));
                if (replayFrom?.type === "start") {
                    expect(history(beforeResponse)).toEqual(expect.arrayContaining([
                        expect.objectContaining({sessionUpdate: "user_message", messageId: "old-receipt"}),
                        expect.objectContaining({sessionUpdate: "agent_message", messageId: "old-answer"}),
                    ]));
                } else {
                    expect(history(beforeResponse)).toEqual([]);
                    expect(history(updates)).toEqual([]);
                }
                // Restored tools still need a complete first upsert before new live output.
                t.codex.emit({method: "item/commandExecution/outputDelta", params: {threadId: THREAD_ID, turnId: "turn-1", itemId: "old-tool", delta: "new output"}});
                itemCompleted(t.codex, {...nativeTool, status: "completed", aggregatedOutput: "old outputnew output", exitCode: 0});
                turnCompleted(t.codex);
                await t.settle();
                expect(updates.some(update => update.sessionUpdate === "terminal_output_chunk")).toBe(true);
                expect(oracle.issues).toEqual([]);
                await client.request("session/close", {sessionId: THREAD_ID});
            });
        } finally {
            turnCompleted(t.codex, {status: "interrupted"});
            server.close();
            await server.closed;
        }
    });
});
