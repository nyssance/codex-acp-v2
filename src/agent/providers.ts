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
/** Default id of a gateway: the Codex `model_providers` entry it is written to and its select group. */
export const GATEWAY_MODEL_PROVIDER = "custom-gateway";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const NATIVE_GROUP_ID = "codex";
const GATEWAY_ID_PATTERN = /^[a-z0-9-]+$/;

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
    /** The gateway id; doubles as the select group id. */
    id: string;
    name: string;
    modelIds: string[];
}

export interface Gateway {
    /** `_meta.codex.id`: the `model_providers` entry, `modelProvider` value and select group of this gateway. */
    id: string;
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
 * Route mode holds one gateway; catalog mode holds any number, each under its own id.
 */
export class ProviderRouting {
    private gateways = new Map<string, Gateway>();

    constructor(
        private readonly baseConfig: JsonObject,
        private readonly configuredProvider: string | null,
    ) {}

    copy(): ProviderRouting {
        const copy = new ProviderRouting(this.baseConfig, this.configuredProvider);
        copy.gateways = new Map(this.gateways);
        return copy;
    }

    /** The first registered gateway (the only one in route mode), or null. */
    get active(): Gateway | null {
        return this.gateways.values().next().value ?? null;
    }

    gateway(id: string | null): Gateway | null {
        return id === null ? null : this.gateways.get(id) ?? null;
    }

    hasGateway(id: string | null): boolean {
        return id !== null && this.gateways.has(id);
    }

    list(): acp.ListProvidersResponse {
        // Catalog mode re-routes nothing by itself, so `current` stays native; the registered
        // gateways are reported under `_meta.codex` for clients that want to show them.
        const first = this.active;
        const routed = first !== null && first.mode === "route";
        const summary = (gateway: Gateway) => ({id: gateway.id, name: gateway.name, baseUrl: gateway.baseUrl, models: gateway.models.map(model => model.id)});
        return {
            providers: [{
                providerId: OPENAI_PROVIDER_ID,
                supported: ["openai"],
                required: false,
                current: routed && first
                    ? {apiType: "openai", baseUrl: first.baseUrl}
                    : {apiType: "openai", baseUrl: this.nativeBaseUrl()},
                ...(first && !routed
                    ? {_meta: {codex: {mode: "catalog", gateway: summary(first), gateways: [...this.gateways.values()].map(summary)}}}
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
        if (hints.id === OPENAI_PROVIDER_ID || hints.id === this.configuredProvider) {
            throw acp.RequestError.invalidParams({id: hints.id}, `_meta.codex.id "${hints.id}" is Codex's own provider; pick another gateway id`);
        }
        // Route mode owns the slot outright; a mode change replaces whatever was registered.
        if (hints.mode === "route" || this.mode !== hints.mode) this.gateways.clear();
        for (const other of this.gateways.values()) {
            if (other.id === hints.id) continue;
            const duplicate = hints.models.find(model => other.models.some(candidate => candidate.id === model.id));
            if (duplicate) {
                throw acp.RequestError.invalidParams({id: hints.id, model: duplicate.id}, `Model "${duplicate.id}" is already served by gateway "${other.id}"; model ids must be unique across gateways`);
            }
        }
        this.gateways.set(hints.id, {
            id: hints.id,
            baseUrl,
            headers: {...(request.headers ?? {})},
            name: hints.name ?? "Client-configured gateway",
            models: hints.models,
            model: hints.model,
            bearerToken: hints.bearerToken,
            config: hints.config,
            mode: hints.mode,
            catalogEntries: hints.catalogEntries,
        });
    }

    get mode(): RoutingMode {
        return this.active?.mode ?? "route";
    }

    /** The gateway serving `modelId`, when one does (catalog mode). */
    gatewayFor(modelId: string): Gateway | null {
        for (const gateway of this.gateways.values()) {
            if (gateway.models.some(model => model.id === modelId)) return gateway;
        }
        return null;
    }

    gatewayIdFor(modelId: string): string | null {
        return this.gatewayFor(modelId)?.id ?? null;
    }

    /** True when `modelId` is served by one of the gateways (catalog mode). */
    isGatewayModel(modelId: string): boolean {
        return this.gatewayFor(modelId) !== null;
    }

    /** The select groups the gateways' models sit in, when they share a catalog with Codex's. */
    gatewayGroups(): GatewayGroup[] {
        if (this.mode !== "catalog") return [];
        return [...this.gateways.values()]
            .filter(gateway => gateway.models.length > 0)
            .map(gateway => ({id: gateway.id, name: gateway.name, modelIds: gateway.models.map(model => model.id)}));
    }

    /**
     * Disabling an unknown provider is a no-op, per the ACP providers RFD. `_meta.codex.id`
     * removes that gateway only; without it every gateway goes.
     */
    disable(request: acp.DisableProviderRequest): void {
        if (request.providerId !== OPENAI_PROVIDER_ID) return;
        const id = readGatewayId((request as {_meta?: unknown})._meta);
        if (id === null) this.gateways.clear();
        else this.gateways.delete(id);
    }

    /** Codex `modelProvider` for new and resumed threads that are not explicitly on a gateway. */
    modelProvider(): string | null {
        return this.defaultGatewayId() ?? this.configuredProvider;
    }

    /** Whether a thread opened now, with no model asked for, runs on the gateway. */
    routesByDefault(): boolean {
        return this.defaultGatewayId() !== null;
    }

    /** The gateway every thread runs on in route mode; null in catalog mode or with none registered. */
    defaultGatewayId(): string | null {
        const first = this.active;
        return first !== null && first.mode === "route" ? first.id : null;
    }

    /** Base thread config; with a gateway's overrides and `model_providers` entry when the thread runs on it. */
    threadConfig(gatewayId: string | null = this.defaultGatewayId()): JsonObject {
        const gateway = this.gateway(gatewayId);
        if (!gateway) return this.baseConfig;
        return this.applyGateway(this.baseConfig, gateway);
    }

    /**
     * Moves a live thread's config (which also carries per-session keys such as
     * `projects`) onto a gateway or back to native.
     */
    routeConfig(config: JsonObject, gatewayId: string | null): JsonObject {
        return this.rebind(config, this, gatewayId);
    }

    /**
     * Top-level keys this routing adds on top of the base config. A later routing
     * change restores or removes them from a live thread's config (`rebind`).
     */
    overrideKeys(): string[] {
        const keys = new Set<string>();
        for (const gateway of this.gateways.values()) for (const key of Object.keys(gateway.config)) keys.add(key);
        return [...keys];
    }

    /**
     * Re-targets a live thread's config (which also carries per-session keys such as
     * `projects`) from `previous` routing to this one: every previous gateway's override
     * keys fall back to the base config, then the target gateway is applied.
     */
    rebind(config: JsonObject, previous: ProviderRouting, gatewayId: string | null = this.defaultGatewayId()): JsonObject {
        const next: JsonObject = {...config};
        for (const key of previous.overrideKeys()) {
            if (key in this.baseConfig) next[key] = this.baseConfig[key]!;
            else delete next[key];
        }
        // Only the target gateway's entry may remain: a thread moved between gateways must not
        // keep the previous one's `model_providers` entry (and its bearer token) in its config.
        delete next["model_providers"];
        if (isRecord(this.baseConfig["model_providers"])) next["model_providers"] = this.baseConfig["model_providers"];
        const gateway = this.gateway(gatewayId);
        return gateway ? this.applyGateway(next, gateway) : next;
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
            model_providers: {...existing, [gateway.id]: entry},
        };
    }

    /**
     * The catalog a session should show. Route mode: the gateway's models when known, else
     * Codex's. Catalog mode: Codex's models followed by every gateway's, in registration order.
     */
    catalog(codexCatalog: Model[]): Model[] {
        const first = this.active;
        if (first === null) return codexCatalog;
        if (first.mode === "route") {
            if (first.models.length === 0) return codexCatalog;
            return first.models.map((model, index) => gatewayModel(model, index === 0, codexCatalog[0], first.catalogEntries.get(model.id)));
        }
        const own: Model[] = [];
        for (const gateway of this.gateways.values()) {
            for (const model of gateway.models) own.push(gatewayModel(model, false, codexCatalog[0], gateway.catalogEntries.get(model.id)));
        }
        return [...codexCatalog, ...own];
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
function readHints(meta: unknown): {id: string; models: GatewayModel[]; model: string | null; name: string | null; bearerToken: string | null; config: JsonObject; mode: RoutingMode; catalogEntries: Map<string, CatalogEntry>} {
    const root = isRecord(meta) ? meta : {};
    const alwith = isRecord(root["alwith"]) ? root["alwith"] : {};
    const codex = isRecord(root["codex"]) ? root["codex"] : {};
    const id = readGatewayId(meta) ?? GATEWAY_MODEL_PROVIDER;
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
    return {id, models, model, name, bearerToken, config, mode, catalogEntries};
}

/** `_meta.codex.id`: which gateway a `providers/set` or `providers/disable` addresses. */
function readGatewayId(meta: unknown): string | null {
    const root = isRecord(meta) ? meta : {};
    const codex = isRecord(root["codex"]) ? root["codex"] : {};
    const raw = codex["id"];
    if (raw === undefined) return null;
    if (typeof raw !== "string" || !GATEWAY_ID_PATTERN.test(raw)) {
        throw acp.RequestError.invalidParams({id: raw}, "_meta.codex.id must match [a-z0-9-]+");
    }
    return raw;
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
