#!/usr/bin/env bun

import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {Readable, Writable} from "node:stream";
import packageJson from "../package.json";
import {createAgentApp} from "./agent/createAgent";
import {AppServerClient} from "./codex/AppServerClient";
import {startCodexProcess} from "./codex/process";
import type {JsonObject} from "./codex/sessionConfig";
import {logger} from "./util/logger";

const CODEX_EXIT_GRACE_MS = 2_000;

if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(`${packageJson.name} ${packageJson.version}`);
    process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`${packageJson.name} ${packageJson.version}

ACP v2 agent for the OpenAI Codex app-server. Speaks newline-delimited JSON-RPC on stdin/stdout.

Environment:
  CODEX_PATH          Codex executable (default: bundled @openai/codex)
  CODEX_CONFIG        JSON object merged into every thread's Codex config
  MODEL_PROVIDER      Codex model provider for new threads
  INITIAL_AGENT_MODE  read-only | agent | agent-full-access (default: agent)
  CODEX_API_KEY       API key for the api-key auth method (falls back to OPENAI_API_KEY)
  NO_BROWSER          Hide the browser-based ChatGPT auth method
  APP_SERVER_LOGS     Directory for the adapter log file`);
    process.exit(0);
}

startAgent();

function startAgent(): void {
    // stdout is the protocol channel; keep any stray console output off it.
    console.log = console.error;
    console.info = console.error;
    console.warn = console.error;
    console.debug = console.error;

    const codexPath = process.env["CODEX_PATH"];
    const config = parseJsonObject(process.env["CODEX_CONFIG"], "CODEX_CONFIG");
    const modelProvider = process.env["MODEL_PROVIDER"];
    logger.log("starting", {name: packageJson.name, version: packageJson.version, codexPath: codexPath ?? null, modelProvider: modelProvider ?? null});

    const codexProcess = startCodexProcess(codexPath);
    const codex = new AppServerClient(codexProcess.connection);

    process.stdin.on("close", () => {
        codexProcess.process.stdin.end();
        setTimeout(() => {
            if (codexProcess.exitCode() === null) {
                logger.log("codex still running after stdin closed; terminating");
                codexProcess.process.kill();
            }
        }, CODEX_EXIT_GRACE_MS).unref();
    });

    const stream = acp.ndJsonStream(
        Writable.toWeb(process.stdout),
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    );
    const app = createAgentApp({
        codex,
        process: codexProcess,
        ...(config === undefined ? {} : {config}),
        ...(modelProvider === undefined ? {} : {modelProvider}),
        info: {name: packageJson.name, title: "Codex", version: packageJson.version},
    });
    const connection = app.connect(stream);
    void connection.closed.then(() => {
        logger.log("client connection closed");
        codexProcess.process.stdin.end();
    });
}

function parseJsonObject(value: string | undefined, name: string): JsonObject | undefined {
    if (!value) return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("expected a JSON object");
        }
        return parsed as JsonObject;
    } catch (error) {
        console.error(`Invalid ${name}: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(2);
    }
}
