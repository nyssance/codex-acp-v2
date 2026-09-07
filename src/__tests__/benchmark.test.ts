import {PassThrough} from "node:stream";
import {createReader} from "../codex/transport";
import {writeFile} from "node:fs/promises";
import os from "node:os";
import {performance} from "node:perf_hooks";
import {expect, it} from "vitest";
import {createTestAgent, itemCompleted, THREAD_ID, TURN_ID, turnCompleted} from "./harness";
import {ProtocolOracle} from "./protocolOracle";

// Opt-in repeatable adapter benchmark: no network or model inference is included.
it.skipIf(process.env["RUN_BENCHMARKS"] !== "true")("sustains 500 turns and 100,000 multilingual chunks without transcript drift", async () => {
    const t = createTestAgent();
    await t.initialize(); await t.openSession();
    const turns = 500, chunks = 200, delta = "你好 🌍 café " .repeat(8);
    const timings: number[] = [];
    const heapSamples: number[] = [];
    const started = performance.now();
    for (let round = 0; round < turns; round++) {
        t.client.clear();
        const begin = performance.now();
        await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: `round ${round}`}]});
        // Yield until turn/start finishes before injecting the server's output.
        while (t.codex.calls("turn/start").length <= round) await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        for (let index = 0; index < chunks; index++) t.codex.emit({method: "item/agentMessage/delta", params: {threadId: THREAD_ID, turnId: TURN_ID, itemId: `answer-${round}`, delta}});
        itemCompleted(t.codex, {type: "agentMessage", id: `answer-${round}`, text: delta.repeat(chunks), phase: "final_answer", memoryCitation: null, delivery: null, questions: null});
        turnCompleted(t.codex, {status: round % 5 === 0 ? "interrupted" : "completed"});
        const deadline = performance.now() + 5_000;
        while (t.client.states().at(-1) !== "idle") {
            if (performance.now() > deadline) throw new Error(`Turn ${round} failed to drain within five seconds`);
            await new Promise(resolve => setImmediate(resolve));
        }
        timings.push(performance.now() - begin);
        const client = new ProtocolOracle();
        for (const update of t.client.updates()) client.accept(update.sessionId, update);
        expect(client.issues).toEqual([]);
        expect(client.messages.get(`${THREAD_ID}:answer-${round}`)).toBe(delta.repeat(chunks));
        expect(t.client.states().filter(state => state === "idle")).toHaveLength(1);
        if (round % 50 === 0) heapSamples.push(process.memoryUsage().heapUsed);
    }
    const durationMs = performance.now() - started;
    await t.agent.closeSession({sessionId: THREAD_ID});
    timings.sort((a, b) => a - b);
    const result = {
        schemaVersion: 1, timestamp: new Date().toISOString(),
        environment: {platform: process.platform, arch: process.arch, runtime: process.version, cpu: os.cpus()[0]?.model},
        workload: {turns, chunksPerTurn: chunks, bytesPerChunk: Buffer.byteLength(delta), interruptedTurns: turns / 5},
        durationMs, chunksPerSecond: turns * chunks / (durationMs / 1000),
        turnLatencyMs: {p50: timings[Math.floor(turns * .5)], p95: timings[Math.floor(turns * .95)], max: timings.at(-1)},
        heapSamplesBytes: heapSamples,
        scope: "In-process adapter plus client validation; excludes model/network/stdio latency. Heap samples are observational, without forced GC."
    };
    const output = process.env["BENCHMARK_OUTPUT"];
    if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n");
    console.info(JSON.stringify(result));
}, 60_000);

it.skipIf(process.env["RUN_BENCHMARKS"] !== "true")("parses a 50 MB fragmented JSON frame without rescanning accumulated input", async () => {
    const source = new PassThrough();
    const reader = createReader(source);
    const text = "a".repeat(50 * 1024 * 1024);
    const bytes = Buffer.from(JSON.stringify({method: "notice", params: {text}}) + "\n");
    let received: unknown;
    reader.listen(message => {received = message;});
    const started = performance.now();
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) source.write(bytes.subarray(offset, offset + 64 * 1024));
    const durationMs = performance.now() - started;
    expect((received as {params: {text: string}}).params.text).toBe(text);
    reader.dispose(); source.destroy();
    const result = {bytes: bytes.length, fragmentBytes: 64 * 1024, durationMs, runtime: process.version, platform: process.platform, arch: process.arch};
    const output = process.env["BENCHMARK_OUTPUT"];
    if (output) await writeFile(output.replace(/\.json$/, "") + "-large-frame.json", JSON.stringify(result, null, 2) + "\n");
    console.info(JSON.stringify(result));
}, 10_000);
