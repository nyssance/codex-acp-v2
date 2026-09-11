import {writeFile} from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {ClientSession, type ClientLink} from "../agent/clientSession";
import type {Session} from "../agent/session";
import {EventBridge} from "../bridge/EventBridge";
import {initialAgentMode} from "../codex/modes";
import {resolveModelSelection} from "../codex/models";
import {model} from "../__tests__/fixtures";
import {ProtocolOracle} from "../__tests__/protocolOracle";

const gc = (globalThis as {gc?: () => void}).gc;
if (!gc) throw new Error("Run with bun --expose-gc src/benchmarks/bridge-soak.ts");
const catalog = [model()];
const session: Session = {
    id: "soak", cwd: process.cwd(), additionalDirectories: [], mcpServerNames: [], catalog, gatewayGroup: null,
    model: resolveModelSelection(catalog, null, null), mode: initialAgentMode({}),
    collaborationMode: "default", fastMode: false, account: null, title: null,
    titleIsExplicit: false, activeTurn: null, lastUsage: null, contextWindow: null, closed: false,
};
let oracle = new ProtocolOracle();
let frames = 0;
const link = {
    async notify(method: string, params: unknown) {
        if (method === "session/update") {
            const {sessionId, update} = params as acp.UpdateSessionNotification;
            oracle.accept(sessionId, update);
            frames++;
        }
    },
    async request() {throw new Error("Unexpected client request in bridge soak");},
} as ClientLink;
const client = new ClientSession(session.id, link, {formElicitation: false, urlElicitation: false});
const bridge = new EventBridge(client, session);
const delta = "你好 🌍 café ".repeat(8);
async function round(index: number) {
    oracle = new ProtocolOracle();
    bridge.beginTurn(); client.reportRunning();
    const turnId = `turn-${index}`, itemId = `answer-${index}`;
    await bridge.handle({method: "item/started", params: {threadId: session.id, turnId, startedAtMs: 0,
        item: {type: "commandExecution", id: `shell-${index}`, command: "fixture", cwd: session.cwd, pluginId: null, scriptPath: null, processId: null,
            source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null}}});
    for (let chunk = 0; chunk < 100; chunk++) await bridge.handle({method: "item/agentMessage/delta", params: {threadId: session.id, turnId, itemId, delta}});
    await bridge.handle({method: "item/completed", params: {threadId: session.id, turnId, completedAtMs: 0,
        item: {type: "agentMessage", id: itemId, text: delta.repeat(100), phase: "final_answer", memoryCitation: null, delivery: null, questions: null}}});
    const outcome = index % 5 === 0 ? "cancelled" : "completed";
    await bridge.finishOpenToolCalls(outcome);
    await client.reportIdle(outcome === "cancelled" ? "cancelled" : "end_turn");
    if (oracle.issues.length || oracle.messages.get(`${session.id}:${itemId}`) !== delta.repeat(100)) throw new Error(`Round ${index}: ${oracle.issues.join(", ") || "transcript drift"}`);
}
for (let index = 0; index < 100; index++) await round(index);
bridge.beginTurn(); oracle = new ProtocolOracle(); gc();
const before = process.memoryUsage();
const started = performance.now();
for (let index = 100; index < 5_100; index++) await round(index);
bridge.beginTurn(); oracle = new ProtocolOracle(); gc();
const after = process.memoryUsage();
const result = {scope: "Isolated EventBridge and ClientSession with schema-validating sink; forced GC; excludes CodexAgent, RPC, network and inference",
    runtime: process.version, platform: process.platform, arch: process.arch, rounds: 5_000, interruptedRounds: 1_000, chunks: 500_000,
    durationMs: performance.now() - started, frames, before, after, heapGrowthBytes: after.heapUsed - before.heapUsed};
console.log(JSON.stringify(result, null, 2));
const output = process.env["BENCHMARK_OUTPUT"];
if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n");
client.dispose(); bridge.dispose();
if (result.heapGrowthBytes > 20 * 1024 * 1024) throw new Error("Retained heap grew by more than 20 MiB after forced GC");
