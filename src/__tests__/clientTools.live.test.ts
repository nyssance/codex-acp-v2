import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {startCodexProcess} from "../codex/process";
import {AppServerClient} from "../codex/AppServerClient";
import {CodexAgent} from "../agent/CodexAgent";
import {FakeClient} from "./harness";
import {startFakeGateway} from "./fakeGateway";

// Real Codex binary + adapter, isolated home and local upstream: no account or paid API.
describe.skipIf(!process.env["CODEX_PATH"])("real Codex client tools", () => {
    it("executes read/write/image callbacks and restores tools after a process restart", async () => {
        const home = await mkdtemp(join(tmpdir(), "codex-client-tools-"));
        const gateway = await startFakeGateway({token: "local-only", reply: "done", toolForRequest: index => {
            const names = ["read", "write", "image", undefined, "read", undefined];
            const name = names[index];
            return name ? {name: `alwith_client_${name}`, arguments: {}} : undefined;
        }});
        const children: ReturnType<typeof startCodexProcess>[] = [];
        const callbacks: string[] = [];
        const tools = {version: 1, revision: "fixture-v1", definitions: ["read", "write", "image"].map(name => ({name, description: name, inputSchema: {type: "object", properties: {}, additionalProperties: false}}))};
        async function connect() {
            const process = startCodexProcess(globalThis.process.env["CODEX_PATH"], {...globalThis.process.env, CODEX_HOME: home, INITIAL_AGENT_MODE: "agent-full-access"});
            children.push(process);
            const client = new FakeClient();
            client.toolResponder = async value => {
                const params = value as {name: string};
                callbacks.push(params.name);
                if (params.name === "write") await writeFile(join(home, "result.txt"), "saved");
                if (params.name === "image") return {success: true, contentItems: [{type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII="}]};
                return {success: true, contentItems: [{type: "text", text: params.name === "read" ? "canvas content" : "saved"}]};
            };
            const agent = new CodexAgent(client, {codex: new AppServerClient(process.connection), process, info: {name: "tool-fixture", version: "1"}, env: {INITIAL_AGENT_MODE: "agent-full-access"}});
            await agent.initialize({protocolVersion: 2, info: {name: "fixture", version: "1"}});
            await agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: gateway.baseUrl, headers: {authorization: "Bearer local-only"}, _meta: {alwith: {model: "fake-model", models: [{id: "fake-model", label: "Fake"}]}}});
            return {agent, client, process};
        }
        async function prompt(active: Awaited<ReturnType<typeof connect>>, sessionId: string) {
            active.client.clear();
            await active.agent.prompt({sessionId, prompt: [{type: "text", text: "use the declared tools"}]});
            await expect.poll(() => active.client.states().at(-1), {timeout: 30000}).toBe("idle");
            expect(active.client.updatesOf("state_update").at(-1)).toMatchObject({stopReason: "end_turn"});
        }
        try {
            const first = await connect();
            const created = await first.agent.newSession({cwd: home, mcpServers: [], _meta: {alwith: {tools}}});
            await prompt(first, created.sessionId);
            expect(callbacks).toEqual(["read", "write", "image"]);
            expect(await readFile(join(home, "result.txt"), "utf8")).toBe("saved");
            await first.agent.closeSession({sessionId: created.sessionId});
            first.process.process.stdin.end();
            await first.process.exited;
            const second = await connect();
            await second.agent.resumeSession({sessionId: created.sessionId, cwd: home, mcpServers: [], _meta: {alwith: {tools}}});
            await prompt(second, created.sessionId);
            expect(callbacks).toEqual(["read", "write", "image", "read"]);
            expect(gateway.requests).toHaveLength(6);
            expect(JSON.stringify(gateway.requests[4]?.body["tools"])).toContain("alwith_client_read");
            await second.agent.closeSession({sessionId: created.sessionId});
        } finally {
            for (const child of children) {
                child.process.stdin.end();
                const timer = setTimeout(() => child.process.kill("SIGKILL"), 3000);
                await child.exited;
                clearTimeout(timer);
            }
            await gateway.close();
            await rm(home, {recursive: true, force: true});
        }
    }, 90000);
});
