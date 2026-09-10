import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {
    MarketplaceAddParams,
    MarketplaceRemoveParams,
    MarketplaceUpgradeParams,
    PluginInstallParams,
    PluginInstalledParams,
    PluginListParams,
    PluginReadParams,
    PluginUninstallParams,
    SkillsConfigWriteParams,
    SkillsListParams,
} from "../app-server/v2";
import {CodexAgent, type CodexAgentOptions, objectParams, parseSessionIdParams} from "./CodexAgent";

/**
 * Registers every ACP v2 method on the SDK's agent builder. Each handler
 * delegates to the `CodexAgent` created for the connection in `onConnect`.
 */
export function createAgentApp(options: CodexAgentOptions): acp.AgentApp {
    let agent: CodexAgent | null = null;
    const current = (): CodexAgent => {
        if (agent === null) throw acp.RequestError.internalError(undefined, "Agent is not connected");
        return agent;
    };
    return acp.agent({name: options.info.name})
        .onConnect((connection) => {
            agent = new CodexAgent(connection.client, options);
        })
        .onRequest(acp.methods.agent.initialize, ctx => current().initialize(ctx.params))
        .onRequest(acp.methods.agent.auth.login, ctx => current().login(ctx.params, ctx.requestId))
        .onRequest(acp.methods.agent.auth.logout, ctx => current().logout(ctx.params))
        .onRequest(acp.methods.agent.providers.list, ctx => current().listProviders(ctx.params))
        .onRequest(acp.methods.agent.providers.set, ctx => current().setProvider(ctx.params))
        .onRequest(acp.methods.agent.providers.disable, ctx => current().disableProvider(ctx.params))
        .onRequest(acp.methods.agent.session.new, ctx => current().newSession(ctx.params, ctx.signal))
        .onRequest(acp.methods.agent.session.resume, ctx => current().resumeSession(ctx.params, ctx.signal))
        .onRequest(acp.methods.agent.session.fork, ctx => current().forkSession(ctx.params, ctx.signal))
        .onRequest(acp.methods.agent.session.list, ctx => current().listSessions(ctx.params))
        .onRequest(acp.methods.agent.session.close, ctx => current().closeSession(ctx.params))
        .onRequest(acp.methods.agent.session.delete, ctx => current().deleteSession(ctx.params))
        .onRequest("_codex/session_archive", {parse: parseSessionIdParams}, ctx => current().archiveSession(ctx.params))
        .onRequest("_codex/session_unarchive", {parse: parseSessionIdParams}, ctx => current().unarchiveSession(ctx.params))
        .onRequest("_codex/skills_list", {parse: objectParams<SkillsListParams>()}, ctx => current().skillsList(ctx.params))
        .onRequest("_codex/skills_config_write", {parse: objectParams<SkillsConfigWriteParams>()}, ctx => current().skillsConfigWrite(ctx.params))
        .onRequest("_codex/plugin_list", {parse: objectParams<PluginListParams>()}, ctx => current().pluginList(ctx.params))
        .onRequest("_codex/plugin_installed", {parse: objectParams<PluginInstalledParams>()}, ctx => current().pluginInstalled(ctx.params))
        .onRequest("_codex/plugin_install", {parse: objectParams<PluginInstallParams>()}, ctx => current().pluginInstall(ctx.params))
        .onRequest("_codex/plugin_uninstall", {parse: objectParams<PluginUninstallParams>()}, ctx => current().pluginUninstall(ctx.params))
        .onRequest("_codex/plugin_read", {parse: objectParams<PluginReadParams>()}, ctx => current().pluginRead(ctx.params))
        .onRequest("_codex/marketplace_add", {parse: objectParams<MarketplaceAddParams>()}, ctx => current().marketplaceAdd(ctx.params))
        .onRequest("_codex/marketplace_remove", {parse: objectParams<MarketplaceRemoveParams>()}, ctx => current().marketplaceRemove(ctx.params))
        .onRequest("_codex/marketplace_upgrade", {parse: objectParams<MarketplaceUpgradeParams>()}, ctx => current().marketplaceUpgrade(ctx.params))
        .onRequest(acp.methods.agent.session.setConfigOption, ctx => current().setSessionConfigOption(ctx.params))
        .onRequest(acp.methods.agent.session.prompt, ctx => current().prompt(ctx.params))
        .onNotification(acp.methods.agent.session.cancel, ctx => current().cancel(ctx.params));
}
