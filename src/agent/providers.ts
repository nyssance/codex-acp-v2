import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {Model} from "../app-server/v2";
import type {JsonObject} from "../codex/sessionConfig";
import {isRecord} from "../permissions/json";

/** The one provider slot Codex exposes: where its OpenAI-protocol traffic goes. */
export const OPENAI_PROVIDER_ID = "openai";
/** Name of the Codex `model_providers` entry the gateway is written to. */
export const GATEWAY_MODEL_PROVIDER = "custom-gateway";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface GatewayModel {
    id: string;
    name: string;
    description: string | null;
}

export interface Gateway {
    baseUrl: string;
    headers: Record<string, string>;
    name: string;
    /** Model catalog the gateway serves, when the client told us; Codex cannot list it. */
    models: GatewayModel[];
    /** Model the client wants selected on the gateway, when it told us. */
    model: string | null;
}

/**
 * Client-configured routing for Codex's OpenAI slot (ACP `providers/*`).
 *
 * A gateway is applied per thread through Codex's `model_providers` config
 * override plus `modelProvider`, so switching never restarts the app-server.
 */
export class ProviderRouting {
    private gateway: Gateway | null = null;

    constructor(
        private readonly baseConfig: JsonObject,
        private readonly configuredProvider: string | null,
    ) {}

    get active(): Gateway | null {
        return this.gateway;
    }

    list(): acp.ListProvidersResponse {
        return {
            providers: [{
                providerId: OPENAI_PROVIDER_ID,
                supported: ["openai"],
                required: false,
                current: this.gateway
                    ? {apiType: "openai", baseUrl: this.gateway.baseUrl}
                    : {apiType: "openai", baseUrl: this.nativeBaseUrl()},
            }],
        };
    }

    set(request: acp.SetProviderRequest): void {
        if (request.providerId !== OPENAI_PROVIDER_ID) {
            throw acp.RequestError.invalidParams({providerId: request.providerId}, `Unknown providerId "${request.providerId}"; only "${OPENAI_PROVIDER_ID}" is configurable`);
        }
        if (request.apiType !== "openai") {
            throw acp.RequestError.invalidParams({apiType: request.apiType}, `Codex only speaks the OpenAI protocol; got apiType "${request.apiType}"`);
        }
        const baseUrl = typeof request.baseUrl === "string" ? request.baseUrl.trim() : "";
        if (!/^https?:\/\//.test(baseUrl)) {
            throw acp.RequestError.invalidParams({baseUrl: request.baseUrl}, "baseUrl must be an http(s) URL");
        }
        const hints = readHints(request._meta);
        this.gateway = {
            baseUrl,
            headers: {...(request.headers ?? {})},
            name: hints.name ?? "Client-configured gateway",
            models: hints.models,
            model: hints.model,
        };
    }

    /** Disabling an unknown provider is a no-op, per the ACP providers RFD. */
    disable(request: acp.DisableProviderRequest): void {
        if (request.providerId === OPENAI_PROVIDER_ID) this.gateway = null;
    }

    /** Codex `modelProvider` for new and resumed threads. */
    modelProvider(): string | null {
        return this.gateway ? GATEWAY_MODEL_PROVIDER : this.configuredProvider;
    }

    /** Base thread config with the gateway written into `model_providers`. */
    threadConfig(): JsonObject {
        if (!this.gateway) return this.baseConfig;
        const existing = isRecord(this.baseConfig["model_providers"]) ? this.baseConfig["model_providers"] : {};
        return {
            ...this.baseConfig,
            model_providers: {
                ...existing,
                [GATEWAY_MODEL_PROVIDER]: {
                    name: this.gateway.name,
                    base_url: this.gateway.baseUrl,
                    // Codex 0.153 dropped chat completions; the Responses API is the only wire protocol left.
                    wire_api: "responses",
                    http_headers: {"X-Client-Feature-ID": "codex", ...this.gateway.headers},
                },
            },
        };
    }

    /** The catalog a session should show: the gateway's models when known, else Codex's. */
    catalog(codexCatalog: Model[]): Model[] {
        if (!this.gateway || this.gateway.models.length === 0) return codexCatalog;
        return this.gateway.models.map((model, index) => gatewayModel(model, index === 0, codexCatalog[0]));
    }

    private nativeBaseUrl(): string {
        const providers = this.baseConfig["model_providers"];
        if (this.configuredProvider && isRecord(providers)) {
            const entry = providers[this.configuredProvider];
            const baseUrl = isRecord(entry) ? entry["base_url"] : undefined;
            if (typeof baseUrl === "string" && baseUrl.length > 0) return baseUrl;
        }
        return DEFAULT_OPENAI_BASE_URL;
    }
}

/**
 * Hints ACP does not standardize yet. `_meta.alwith.{model, models}` is what ALwith
 * Desktop sends with `providers/set`; `_meta.codex.name` labels the provider.
 */
function readHints(meta: unknown): {models: GatewayModel[]; model: string | null; name: string | null} {
    const root = isRecord(meta) ? meta : {};
    const alwith = isRecord(root["alwith"]) ? root["alwith"] : {};
    const codex = isRecord(root["codex"]) ? root["codex"] : {};
    const models: GatewayModel[] = [];
    if (Array.isArray(alwith["models"])) {
        for (const entry of alwith["models"]) {
            if (!isRecord(entry) || typeof entry["id"] !== "string" || entry["id"].length === 0) continue;
            models.push({
                id: entry["id"],
                name: typeof entry["label"] === "string" && entry["label"].length > 0 ? entry["label"] : entry["id"],
                description: typeof entry["description"] === "string" ? entry["description"] : null,
            });
        }
    }
    const model = typeof alwith["model"] === "string" && alwith["model"].length > 0 ? alwith["model"] : null;
    const name = typeof codex["name"] === "string" && codex["name"].length > 0 ? codex["name"] : null;
    return {models, model, name};
}

/** Synthesizes a Codex `Model` for a gateway model so the session catalog stays one shape. */
function gatewayModel(model: GatewayModel, isDefault: boolean, template: Model | undefined): Model {
    return {
        id: model.id,
        model: model.id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: model.name,
        description: model.description ?? "",
        modelSpecialty: null,
        hidden: false,
        supportedReasoningEfforts: template?.supportedReasoningEfforts ?? [],
        defaultReasoningEffort: template?.defaultReasoningEffort ?? "medium",
        inputModalities: ["text", "image"],
        supportsPersonality: false,
        multiAgentVersion: null,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault,
    };
}
