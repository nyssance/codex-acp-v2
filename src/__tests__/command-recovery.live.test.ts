import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, expect, it, vi} from "vitest";
import {startCodexProcess} from "../codex/process";
import {AppServerClient} from "../codex/AppServerClient";
import {CodexAgent} from "../agent/CodexAgent";
import {CommandReceipts} from "../agent/commandReceipts";
import {FakeClient} from "./harness";
import {startFakeGateway} from "./fakeGateway";

// Real app-server and local upstream; only the receipt disk read is fault-injected.
describe.skipIf(process.env["RUN_E2E_TESTS"] !== "true")("real Codex command recovery", () => {
    it.each([false, true])("resumes without history replay and stops native work (stalled read: %s)", async stalled => {
        const home = await mkdtemp(path.join(tmpdir(), "acp-live-command-recovery-"));
        const gateway = await startFakeGateway({token: "local-only", reply: "done", delayMs: 10_000});
        const child = startCodexProcess(process.env["CODEX_PATH"], {...process.env, CODEX_HOME: home});
        const codex = new AppServerClient(child.connection);
        const receipts = new CommandReceipts(home);
        let release: (() => void) | undefined;
        if (stalled) vi.spyOn(receipts, "read").mockImplementation(async () => {
            await new Promise<void>(resolve => { release = resolve; });
            return null;
        });
        const client = new FakeClient();
        const agent = new CodexAgent(client, {codex, process: child, commandReceipts: receipts, cancelGraceMs: 500,
            info: {name: "recovery-fixture", version: "1"}, env: {INITIAL_AGENT_MODE: "agent-full-access"}});
        try {
            await agent.initialize({protocolVersion: 2, info: {name: "fixture", version: "1"}});
            await agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: gateway.baseUrl, headers: {authorization: "Bearer local-only"},
                _meta: {codex: {id: "fixture"}, alwith: {model: "fake-model", models: [{id: "fake-model", label: "Fake"}]}}});
            // Start work before the adapter has a session runtime, then join it through resume.
            const native = await codex.threadStart({cwd: home, model: "fake-model", modelProvider: "fixture", approvalPolicy: "never",
                config: {model_providers: {fixture: {name: "Fixture", base_url: gateway.baseUrl, wire_api: "responses", experimental_bearer_token: "local-only"}}}});
            const sessionId = native.thread.id;
            await codex.turnStart({threadId: sessionId, clientUserMessageId: "original-receipt", input: [{type: "text", text: "wait for a reply", text_elements: []}]});
            await expect.poll(() => gateway.requests.length, {timeout: 15_000}).toBeGreaterThan(0);
            await agent.resumeSession({sessionId, cwd: home});
            if (stalled) await expect.poll(() => release !== undefined).toBe(true);
            expect(client.updatesOf("user_message")).toHaveLength(0);
            expect(client.updatesOf("agent_message")).toHaveLength(0);
            expect(client.states().at(-1)).toBe("running");
            await agent.cancel({sessionId});
            await expect.poll(() => client.states().at(-1), {timeout: 5_000}).toBe("idle");
            expect(client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "cancelled"});
            const state = await codex.threadRead({threadId: sessionId, includeTurns: false});
            expect(state.thread.status.type).toBe("idle");
            const mark = client.updates().length;
            release?.();
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(client.updates()).toHaveLength(mark);
            expect(client.updatesOf("user_message")).toHaveLength(0);
            await agent.closeSession({sessionId});
        } finally {
            release?.();
            child.process.stdin.end();
            const timer = setTimeout(() => child.process.kill("SIGKILL"), 3000);
            await child.exited;
            clearTimeout(timer);
            await gateway.close();
        }
    }, 45_000);
});
