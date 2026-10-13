import type {AppServerClient} from "./AppServerClient";

/** Remote enablement belongs to plugin-service; local config is ignored for remote installs. */
export async function setRemotePluginEnabled(codex: AppServerClient, remotePluginId: string, enabled: boolean): Promise<void> {
    const account = await codex.accountRead({refreshToken: false});
    const routing = account.workspaceRouting;
    if (account.account?.type !== "chatgpt" || !routing) throw new Error("Sign in to ChatGPT to change remote plugins");
    const origin = new URL(routing.backendOrigin);
    if (origin.protocol !== "https:" || (origin.hostname !== "chatgpt.com" && !origin.hostname.endsWith(".chatgpt.com"))) {
        throw new Error("Unsupported ChatGPT backend for remote plugins");
    }
    const url = new URL(`/backend-api/ps/plugins/${encodeURIComponent(remotePluginId)}/${enabled ? "enable" : "disable"}`, origin);
    for (const refreshToken of [false, true]) {
        const auth = await codex.getAuthStatus({includeToken: true, refreshToken});
        if ((auth.authMethod !== "chatgpt" && auth.authMethod !== "chatgptAuthTokens") || !auth.authToken) {
            throw new Error("ChatGPT credentials are unavailable; sign in again to change remote plugins");
        }
        const response = await fetch(url, {
            method: "POST",
            headers: {Authorization: `Bearer ${auth.authToken}`, "ChatGPT-Account-Id": routing.chatgptAccountId, "OpenAI-Product-SKU": "codex"},
            redirect: "error",
            signal: AbortSignal.any([codex.disconnectSignal, AbortSignal.timeout(30_000)]),
        });
        if (response.status === 401 && !refreshToken) { await response.body?.cancel(); continue; }
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Remote plugin ${enabled ? "enable" : "disable"} failed (HTTP ${response.status})`);
        }
        const result: unknown = await response.json();
        if (typeof result !== "object" || result === null || !("id" in result) || result.id !== remotePluginId || !("enabled" in result) || result.enabled !== enabled) {
            throw new Error("Remote plugin service did not confirm the requested enabled state");
        }
        return;
    }
}
