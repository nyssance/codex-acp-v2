import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import open from "open";
import type {AppServerClient} from "../codex/AppServerClient";
import {logger} from "../util/logger";
import type {ClientCapabilitySet, ClientLink} from "./clientSession";

export const AuthMethodId = {
    ApiKey: "api-key",
    ChatGpt: "chat-gpt",
    ChatGptDeviceCode: "chat-gpt-device-code",
} as const;

export const CODEX_API_KEY_ENV = "CODEX_API_KEY";
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

export function authMethods(capabilities: ClientCapabilitySet, env: NodeJS.ProcessEnv = process.env): acp.AuthMethod[] {
    const methods: acp.AuthMethod[] = [{
        type: "agent",
        methodId: AuthMethodId.ApiKey,
        name: "API key",
        description: `Use the API key from ${CODEX_API_KEY_ENV} or ${OPENAI_API_KEY_ENV}, or pass it in _meta["api-key"].apiKey`,
    }];
    if (!env["NO_BROWSER"]) {
        methods.push({
            type: "agent",
            methodId: AuthMethodId.ChatGpt,
            name: "ChatGPT",
            description: "Sign in to ChatGPT in your browser",
        });
    }
    if (capabilities.urlElicitation) {
        methods.push({
            type: "agent",
            methodId: AuthMethodId.ChatGptDeviceCode,
            name: "ChatGPT (device code)",
            description: "Sign in to ChatGPT by opening a verification page and entering a one-time code",
        });
    }
    return methods;
}

/** Runs the selected login flow against Codex; resolves once Codex reports the outcome. */
export async function login(
    codex: AppServerClient,
    link: ClientLink,
    request: acp.LoginAuthRequest,
    requestId: acp.JsonRpcId | null,
    env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    switch (request.methodId) {
        case AuthMethodId.ApiKey:
            return await loginWithApiKey(codex, request, env);
        case AuthMethodId.ChatGpt:
            return await loginWithChatGpt(codex);
        case AuthMethodId.ChatGptDeviceCode:
            return await loginWithDeviceCode(codex, link, requestId);
        default:
            throw acp.RequestError.invalidParams(
                {methodId: request.methodId},
                `Unknown auth method "${request.methodId}"; expected one of ${Object.values(AuthMethodId).join(", ")}`,
            );
    }
}

async function loginWithApiKey(codex: AppServerClient, request: acp.LoginAuthRequest, env: NodeJS.ProcessEnv): Promise<void> {
    const meta = request._meta?.["api-key"];
    const fromMeta = typeof meta === "object" && meta !== null ? (meta as {apiKey?: unknown}).apiKey : undefined;
    const apiKey = typeof fromMeta === "string" && fromMeta.trim().length > 0
        ? fromMeta.trim()
        : env[CODEX_API_KEY_ENV]?.trim() || env[OPENAI_API_KEY_ENV]?.trim();
    if (!apiKey) {
        throw acp.RequestError.invalidParams(
            {envVars: [CODEX_API_KEY_ENV, OPENAI_API_KEY_ENV]},
            `No API key: set ${CODEX_API_KEY_ENV} or ${OPENAI_API_KEY_ENV}, or pass _meta["api-key"].apiKey`,
        );
    }
    const completed = codex.awaitNotification("account/login/completed");
    await codex.accountLogin({type: "apiKey", apiKey});
    const result = await completed;
    if (!result.success) throw acp.RequestError.authRequired({error: result.error}, result.error ?? "API key login failed");
}

async function loginWithChatGpt(codex: AppServerClient): Promise<void> {
    const account = await codex.accountRead({refreshToken: true});
    if (account.account?.type === "chatgpt") return;
    const completed = codex.awaitNotification("account/login/completed");
    const started = await codex.accountLogin({type: "chatgpt"});
    if (started.type !== "chatgpt") throw acp.RequestError.internalError({type: started.type}, "Unexpected login response");
    logger.log("opening browser for ChatGPT login", {loginId: started.loginId});
    await open(started.authUrl);
    const result = await completed;
    if (!result.success) throw acp.RequestError.authRequired({error: result.error}, result.error ?? "ChatGPT login failed");
}

async function loginWithDeviceCode(codex: AppServerClient, link: ClientLink, requestId: acp.JsonRpcId | null): Promise<void> {
    const account = await codex.accountRead({refreshToken: true});
    if (account.account?.type === "chatgpt") return;
    const completed = codex.awaitNotification("account/login/completed");
    const started = await codex.accountLogin({type: "chatgptDeviceCode"});
    if (started.type !== "chatgptDeviceCode") throw acp.RequestError.internalError({type: started.type}, "Unexpected login response");
    // The login is not tied to a session, so the elicitation is scoped to the auth/login request.
    const elicitation = link.request(acp.methods.client.elicitation.create, {
        mode: "url",
        requestId,
        elicitationId: started.loginId,
        url: started.verificationUrl,
        message: `Sign in to ChatGPT and enter this code: ${started.userCode}`,
    });
    void elicitation.catch(() => {});
    const first = await Promise.race([
        completed.then(result => ({kind: "completed" as const, result})),
        elicitation.then(response => ({kind: "elicitation" as const, response})),
    ]);
    if (first.kind === "elicitation" && !acp.CreateElicitationResponse.isAccept(first.response)) {
        await codex.accountLoginCancel({loginId: started.loginId});
        throw acp.RequestError.authRequired(undefined, "ChatGPT device code login was cancelled");
    }
    const result = first.kind === "completed" ? first.result : await completed;
    await link.notify(acp.methods.client.elicitation.complete, {elicitationId: started.loginId});
    if (!result.success) throw acp.RequestError.authRequired({error: result.error}, result.error ?? "ChatGPT login failed");
}

export async function logout(codex: AppServerClient): Promise<void> {
    const updated = codex.awaitNotification("account/updated");
    await codex.accountLogout();
    await updated;
}

/** True when Codex needs an OpenAI login before it can serve turns. */
export async function authRequired(codex: AppServerClient): Promise<boolean> {
    const account = await codex.accountRead({refreshToken: false});
    return account.requiresOpenaiAuth && account.account === null;
}
