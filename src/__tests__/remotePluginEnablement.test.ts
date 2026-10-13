import {afterEach, describe, expect, it, vi} from "vitest";
import {createTestAgent} from "./harness";

const remotePluginId = "plugin_supabase";
const params = {pluginId: "supabase@openai-curated-remote", remotePluginId, enabled: false};
async function setup() {
    const t = createTestAgent();
    await t.initialize();
    t.codex.respond("account/read", () => ({account: {type: "chatgpt"}, workspaceRouting: {backendOrigin: "https://chatgpt.com", chatgptAccountId: "workspace"}}));
    t.codex.respond("getAuthStatus", () => ({authMethod: "chatgpt", authToken: "test-token"}));
    t.codex.respond("plugin/reconcile", () => ({changedPlugins: [], failedRemotePluginIds: [], failedMaterializationRemotePluginIds: []}));
    t.codex.respond("plugin/installed", () => ({marketplaces: [{plugins: [{id: params.pluginId, remotePluginId, installed: true, enabled: false}]}]}));
    return t;
}
afterEach(() => vi.unstubAllGlobals());
describe("remote plugin enablement", () => {
    it.each([false, true])("changes remote state to %s, reconciles and checks readback without writing local config", async enabled => {
        const t = await setup();
        t.codex.respond("plugin/installed", () => ({marketplaces: [{plugins: [{remotePluginId, installed: true, enabled}]}]}));
        const request = vi.fn().mockResolvedValue(Response.json({id: remotePluginId, enabled}));
        vi.stubGlobal("fetch", request);
        expect(await t.agent.pluginSetEnabled({...params, enabled})).toEqual({enabled});
        expect(request.mock.calls[0]![0].toString()).toBe(`https://chatgpt.com/backend-api/ps/plugins/plugin_supabase/${enabled ? "enable" : "disable"}`);
        expect(request.mock.calls[0]![1]).toMatchObject({method: "POST", headers: {Authorization: "Bearer test-token", "ChatGPT-Account-Id": "workspace"}, redirect: "error"});
        expect(t.codex.calls("config/value/write")).toEqual([]);
        expect(t.codex.calls("plugin/reconcile")).toHaveLength(1);
        await t.settle();
        expect(t.client.notifications.filter(n => n.method === "_codex/skills_changed")).toHaveLength(1);
    });
    it("refreshes expired credentials once", async () => {
        const t = await setup();
        const request = vi.fn().mockResolvedValueOnce(new Response(null, {status: 401})).mockResolvedValueOnce(Response.json({id: remotePluginId, enabled: false}));
        vi.stubGlobal("fetch", request);
        await t.agent.pluginSetEnabled(params);
        expect(t.codex.calls("getAuthStatus").map(c => c.params)).toEqual([{includeToken: true, refreshToken: false}, {includeToken: true, refreshToken: true}]);
    });
    it("rejects service failure without exposing its response or a success notification", async () => {
        const t = await setup();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("sensitive response", {status: 403})));
        await expect(t.agent.pluginSetEnabled(params)).rejects.toThrow("HTTP 403");
        expect(t.codex.calls("plugin/reconcile")).toEqual([]);
        expect(t.client.notifications.filter(n => n.method === "_codex/skills_changed")).toEqual([]);
    });
    it("rejects stale readback instead of reporting success", async () => {
        const t = await setup();
        t.codex.respond("plugin/installed", () => ({marketplaces: [{plugins: [{remotePluginId, enabled: true}]}]}));
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({id: remotePluginId, enabled: false})));
        await expect(t.agent.pluginSetEnabled(params)).rejects.toThrow("could not be synchronized");
    });
    it("refuses to send ChatGPT credentials to a non-ChatGPT backend", async () => {
        const t = await setup();
        t.codex.respond("account/read", () => ({account: {type: "chatgpt"}, workspaceRouting: {backendOrigin: "https://example.com", chatgptAccountId: "workspace"}}));
        const request = vi.fn();
        vi.stubGlobal("fetch", request);
        await expect(t.agent.pluginSetEnabled(params)).rejects.toThrow("Unsupported ChatGPT backend");
        expect(t.codex.calls("getAuthStatus")).toEqual([]);
        expect(request).not.toHaveBeenCalled();
    });
});
