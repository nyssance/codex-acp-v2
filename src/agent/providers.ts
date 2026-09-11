import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import type {Model, ReasoningEffortOption} from "../app-server/v2";
import type {InputModality} from "../app-server/InputModality";
import type {JsonObject} from "../codex/sessionConfig";
import {isRecord} from "../permissions/json";

/** The one provider slot Codex exposes: where its OpenAI-protocol traffic goes. */
export const OPENAI_PROVIDER_ID = "openai";
/** Name of the Codex `model_providers` entry the gateway is written to. */
export const GATEWAY_MODEL_PROVIDER = "custom-gateway";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Group id of the gateway's models in a catalog-mode `model` option. */
export const GATEWAY_GROUP_ID = "custom-gateway";
export const NATIVE_GROUP_ID = "codex";

/**
 * `route`: the gateway takes over Codex's OpenAI slot for every session (the original
 * behaviour). `catalog`: nothing is re-routed; the gateway's models are offered next to
 * Codex's in every session's `model` option and a session moves to the gateway only
 * when one of them is selected.
 */
export type RoutingMode = "route" | "catalog";

export interface GatewayModel {
    id: string;
    name: string;
    description: string | null;
}

/** What a Codex model catalog file (`model_catalog_json`) says about one model. */
export interface CatalogEntry {
    displayName: string | null;
    description: string | null;
    efforts: ReasoningEffortOption[];
    defaultEffort: string | null;
    inputModalities: InputModality[] | null;
}

export interface GatewayGroup {
    name: string;
    modelIds: string[];
}

export interface Gateway {
    baseUrl: string;
    headers: Record<string, string>;
    name: string;
    /** Model catalog the gateway serves, when the client told us; Codex cannot list it. */
    models: GatewayModel[];
    /** Model the client wants selected on the gateway, when it told us. */
    model: string | null;
    /** Bearer token Codex sends itself (`experimental_bearer_token`), when the client told us. */
    bearerToken: string | null;
    /** Extra top-level Codex thread-config keys that ride along with the gateway (`_meta.codex.config`). */
    config: JsonObject;
    mode: RoutingMode;
    /** Entries of `config.model_catalog_json`, keyed by slug, when the client pointed at one. */
    catalogEntries: Map<string, CatalogEntry>;
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

    copy(): ProviderRouting {
        const copy = new ProviderRouting(this.baseConfig, this.configuredProvider);
        copy.gateway = this.gateway;
        return copy;
    }

    get active(): Gateway | null {
        return this.gateway;
    }

    list(): acp.ListProvidersResponse {
        // Catalog mode re-routes nothing by itself, so `current` stays native; the registered
        // gateway is reported under `_meta.codex` for clients that want to show it.
        const routed = this.gateway !== null && this.gateway.mode === "route";
        return {
            providers: [{
                providerId: OPENAI_PROVIDER_ID,
                supported: ["openai"],
                required: false,
                current: routed && this.gateway
                    ? {apiType: "openai", baseUrl: this.gateway.baseUrl}
                    : {apiType: "openai", baseUrl: this.nativeBaseUrl()},
                ...(this.gateway && !routed
                    ? {_meta: {codex: {mode: "catalog", gateway: {name: this.gateway.name, baseUrl: this.gateway.baseUrl, models: this.gateway.models.map(model => model.id)}}}}
                    : {}),
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
            bearerToken: hints.bearerToken,
            config: hints.config,
            mode: hints.mode,
            catalogEntries: hints.catalogEntries,
        };
    }

    get mode(): RoutingMode {
        return this.gateway?.mode ?? "route";
    }

    /** True when `modelId` is one of the gateway's models (catalog mode). */
    isGatewayModel(modelId: string): boolean {
        return this.gateway !== null && this.gateway.models.some(model => model.id === modelId);
    }

    /** The select group the gateway's models sit in, when they share a catalog with Codex's. */
    gatewayGroup(): GatewayGroup | null {
        if (!this.gateway || this.gateway.mode !== "catalog" || this.gateway.models.length === 0) return null;
        return {name: this.gateway.name, modelIds: this.gateway.models.map(model => model.id)};
    }

    /** Disabling an unknown provider is a no-op, per the ACP providers RFD. */
    disable(request: acp.DisableProviderRequest): void {
        if (request.providerId === OPENAI_PROVIDER_ID) this.gateway = null;
    }

    /** Codex `modelProvider` for new and resumed threads that are not explicitly on the gateway. */
    modelProvider(): string | null {
        return this.gateway && this.gateway.mode === "route" ? GATEWAY_MODEL_PROVIDER : this.configuredProvider;
    }

    /** Whether a thread opened now, with no model asked for, runs on the gateway. */
    routesByDefault(): boolean {
        return this.gateway !== null && this.gateway.mode === "route";
    }

    /** Base thread config; with the gateway's overrides and `model_providers` entry when the thread runs on it. */
    threadConfig(onGateway: boolean = this.routesByDefault()): JsonObject {
        if (!this.gateway || !onGateway) return this.baseConfig;
        return this.applyGateway(this.baseConfig, this.gateway);
    }

    /**
     * Moves a live thread's config (which also carries per-session keys such as
     * `projects`) onto or off the gateway.
     */
    routeConfig(config: JsonObject, onGateway: boolean): JsonObject {
        return this.rebind(config, this, onGateway);
    }

    /**
     * Top-level keys this routing adds on top of the base config. A later routing
     * change restores or removes them from a live thread's config (`rebind`).
     */
    overrideKeys(): string[] {
        return this.gateway ? Object.keys(this.gateway.config) : [];
    }

    /**
     * Re-targets a live thread's config (which also carries per-session keys such as
     * `projects`) from `previous` routing to this one: the previous gateway's override
     * keys fall back to the base config, then this gateway is applied.
     */
    rebind(config: JsonObject, previous: ProviderRouting, onGateway: boolean = this.routesByDefault()): JsonObject {
        const next: JsonObject = {...config};
        for (const key of previous.overrideKeys()) {
            if (key in this.baseConfig) next[key] = this.baseConfig[key]!;
            else delete next[key];
        }
        if (!this.gateway || !onGateway) {
            delete next["model_providers"];
            if (isRecord(this.baseConfig["model_providers"])) next["model_providers"] = this.baseConfig["model_providers"];
            return next;
        }
        return this.applyGateway(next, this.gateway);
    }

    private applyGateway(config: JsonObject, gateway: Gateway): JsonObject {
        const existing = isRecord(config["model_providers"]) ? config["model_providers"] : {};
        const entry: JsonObject = {
            name: gateway.name,
            base_url: gateway.baseUrl,
            // Codex 0.153 dropped chat completions; the Responses API is the only wire protocol left.
            wire_api: "responses",
            http_headers: {"X-Client-Feature-ID": "codex", ...gateway.headers},
        };
        // How DeepSeek's official Codex integration passes the key; Codex adds the Authorization header itself.
        if (gateway.bearerToken !== null) entry["experimental_bearer_token"] = gateway.bearerToken;
        return {
            ...config,
            ...gateway.config,
            model_providers: {...existing, [GATEWAY_MODEL_PROVIDER]: entry},
        };
    }

    /**
     * The catalog a session should show. Route mode: the gateway's models when known, else
     * Codex's. Catalog mode: Codex's models followed by the gateway's.
     */
    catalog(codexCatalog: Model[]): Model[] {
        if (!this.gateway || this.gateway.models.length === 0) return codexCatalog;
        const gateway = this.gateway;
        const own = gateway.models.map((model, index) => gatewayModel(model, gateway.mode === "route" && index === 0, codexCatalog[0], gateway.catalogEntries.get(model.id)));
        return gateway.mode === "catalog" ? [...codexCatalog, ...own] : own;
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
 * Desktop sends with `providers/set`; `_meta.codex.name` labels the provider,
 * `_meta.codex.bearerToken` is the key Codex sends itself, and `_meta.codex.config` is
 * extra top-level thread config (`model_catalog_json`, `web_search`, …) that only
 * applies while this gateway is active.
 */
function readHints(meta: unknown): {models: GatewayModel[]; model: string | null; name: string | null; bearerToken: string | null; config: JsonObject; mode: RoutingMode; catalogEntries: Map<string, CatalogEntry>} {
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
    const bearerToken = typeof codex["bearerToken"] === "string" && codex["bearerToken"].length > 0 ? codex["bearerToken"] : null;
    const rawConfig = codex["config"];
    if (rawConfig !== undefined && !isRecord(rawConfig)) {
        throw acp.RequestError.invalidParams({config: rawConfig}, "_meta.codex.config must be an object of top-level Codex config keys");
    }
    const config: JsonObject = {};
    if (isRecord(rawConfig)) {
        for (const [key, value] of Object.entries(rawConfig)) {
            if (key === "model_providers") throw acp.RequestError.invalidParams({config: rawConfig}, "_meta.codex.config cannot set model_providers; that entry is derived from baseUrl and headers");
            config[key] = value as JsonObject[string];
        }
    }
    const rawMode = codex["mode"];
    if (rawMode !== undefined && rawMode !== "route" && rawMode !== "catalog") {
        throw acp.RequestError.invalidParams({mode: rawMode}, "_meta.codex.mode must be \"route\" or \"catalog\"");
    }
    const mode: RoutingMode = rawMode === "catalog" ? "catalog" : "route";
    if (mode === "catalog" && models.length === 0) {
        throw acp.RequestError.invalidParams(undefined, "_meta.codex.mode \"catalog\" needs _meta.alwith.models: the models offered next to Codex's");
    }
    const catalogPath = config["model_catalog_json"];
    const catalogEntries = typeof catalogPath === "string" ? readCatalogFile(catalogPath) : new Map<string, CatalogEntry>();
    return {models, model, name, bearerToken, config, mode, catalogEntries};
}

/**
 * Reads a Codex model catalog file so gateway models carry their real reasoning levels,
 * modalities and names; Codex loads the same file per thread but `model/list` never
 * reflects it.
 */
function readCatalogFile(catalogPath: string): Map<string, CatalogEntry> {
    const resolved = catalogPath.startsWith("~/") ? path.join(os.homedir(), catalogPath.slice(2)) : catalogPath;
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(resolved, "utf8"));
    } catch (error) {
        throw acp.RequestError.invalidParams({model_catalog_json: catalogPath}, `model_catalog_json could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const models = isRecord(parsed) && Array.isArray(parsed["models"]) ? parsed["models"] : null;
    if (models === null) throw acp.RequestError.invalidParams({model_catalog_json: catalogPath}, "model_catalog_json must be {models: [...]} as Codex expects");
    const entries = new Map<string, CatalogEntry>();
    for (const entry of models) {
        if (!isRecord(entry) || typeof entry["slug"] !== "string") continue;
        const levels = Array.isArray(entry["supported_reasoning_levels"]) ? entry["supported_reasoning_levels"] : [];
        const efforts: ReasoningEffortOption[] = [];
        for (const level of levels) {
            if (!isRecord(level) || typeof level["effort"] !== "string") continue;
            efforts.push({reasoningEffort: level["effort"] as ReasoningEffortOption["reasoningEffort"], description: typeof level["description"] === "string" ? level["description"] : ""});
        }
        const modalities = Array.isArray(entry["input_modalities"])
            ? entry["input_modalities"].filter((value): value is InputModality => value === "text" || value === "image")
            : null;
        entries.set(entry["slug"], {
            displayName: typeof entry["display_name"] === "string" ? entry["display_name"] : null,
            description: typeof entry["description"] === "string" ? entry["description"] : null,
            efforts,
            defaultEffort: typeof entry["default_reasoning_level"] === "string" ? entry["default_reasoning_level"] : null,
            inputModalities: modalities,
        });
    }
    return entries;
}

/** Synthesizes a Codex `Model` for a gateway model so the session catalog stays one shape. */
function gatewayModel(model: GatewayModel, isDefault: boolean, template: Model | undefined, entry: CatalogEntry | undefined): Model {
    const efforts = entry && entry.efforts.length > 0 ? entry.efforts : template?.supportedReasoningEfforts ?? [];
    const defaultEffort = (entry?.defaultEffort ?? template?.defaultReasoningEffort ?? "medium") as Model["defaultReasoningEffort"];
    return {
        id: model.id,
        model: model.id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: model.name !== model.id ? model.name : entry?.displayName ?? model.name,
        description: model.description ?? entry?.description ?? "",
        modelSpecialty: null,
        hidden: false,
        supportedReasoningEfforts: efforts,
        defaultReasoningEffort: defaultEffort,
        inputModalities: entry?.inputModalities ?? ["text", "image"],
        supportsPersonality: false,
        multiAgentVersion: null,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault,
    };
}
