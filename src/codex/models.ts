import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {Model, ReasoningEffortOption} from "../app-server/v2";
import type {ModeKind} from "../app-server/ModeKind";

export const MODEL_CONFIG_ID = "model";
export const EFFORT_CONFIG_ID = "effort";
export const FAST_MODE_CONFIG_ID = "fast_mode";
export const COLLABORATION_MODE_CONFIG_ID = "collaboration_mode";

export const DEFAULT_EFFORT = "medium";
export const FAST_SERVICE_TIER = "fast";

/** Model selection for a session: a catalog id plus a reasoning effort. */
export interface ModelSelection {
    readonly model: string;
    readonly effort: string;
}

/**
 * Resolves the session model from what Codex reported. A model missing from the
 * catalog is kept verbatim: custom providers serve ids the catalog does not list,
 * and substituting the default would send every turn to the wrong model.
 */
export function resolveModelSelection(catalog: readonly Model[], modelId: string | null, effort: string | null): ModelSelection {
    const listed = modelId === null ? undefined : catalog.find(model => model.id === modelId);
    if (listed) return {model: listed.id, effort: effort ?? listed.defaultReasoningEffort};
    if (modelId) return {model: modelId, effort: effort ?? DEFAULT_EFFORT};
    const fallback = catalog.find(model => model.isDefault) ?? catalog[0];
    if (!fallback) throw new Error("Codex did not return any models");
    return {model: fallback.id, effort: effort ?? fallback.defaultReasoningEffort};
}

export function findModel(catalog: readonly Model[], modelId: string): Model | undefined {
    return catalog.find(model => model.id === modelId);
}

export function supportedEfforts(model: Model | undefined): readonly ReasoningEffortOption[] {
    return model?.supportedReasoningEfforts ?? [];
}

/** Picks a supported effort for a newly selected model, keeping the current one when it still applies. */
export function coerceEffort(model: Model | undefined, effort: string): string {
    const options = supportedEfforts(model);
    if (options.length === 0) return effort;
    if (options.some(option => option.reasoningEffort === effort)) return effort;
    return model?.defaultReasoningEffort ?? options[0]!.reasoningEffort;
}

export function modelSupportsFast(model: Model | undefined): boolean {
    if (!model) return false;
    return model.serviceTiers.some(tier => tier.id === FAST_SERVICE_TIER)
        || model.additionalSpeedTiers.includes(FAST_SERVICE_TIER);
}

export function modelSupportsImages(model: Model | undefined): boolean {
    return model?.inputModalities.includes("image") ?? true;
}

/** True when the model offers no reasoning at all, so reasoning summaries must be disabled. */
export function modelLacksReasoning(model: Model | undefined): boolean {
    const options = supportedEfforts(model);
    return options.length > 0 && options.every(option => option.reasoningEffort === "none");
}

export function modelConfigOption(catalog: readonly Model[], current: string): acp.SessionConfigOption {
    const visible = catalog.filter(model => !model.hidden || model.id === current);
    const options = visible.map(model => ({
        value: model.id,
        name: model.displayName,
        description: model.description || null,
    }));
    if (!options.some(option => option.value === current)) {
        options.unshift({value: current, name: current, description: null});
    }
    return {
        configId: MODEL_CONFIG_ID,
        name: "Model",
        description: "Model Codex uses for this session",
        category: "model",
        type: "select",
        currentValue: current,
        options,
    };
}

export function effortConfigOption(efforts: readonly ReasoningEffortOption[], current: string): acp.SessionConfigOption {
    const options = efforts.map(option => ({
        value: option.reasoningEffort,
        name: capitalize(option.reasoningEffort),
        description: option.description || null,
    }));
    if (!options.some(option => option.value === current)) {
        options.unshift({value: current, name: capitalize(current), description: null});
    }
    return {
        configId: EFFORT_CONFIG_ID,
        name: "Reasoning effort",
        description: "How much reasoning effort the model should use",
        category: "thought_level",
        type: "select",
        currentValue: current,
        options,
    };
}

export function fastModeConfigOption(enabled: boolean): acp.SessionConfigOption {
    return {
        configId: FAST_MODE_CONFIG_ID,
        name: "Fast mode",
        description: "1.5x speed, increased usage",
        category: "model_config",
        type: "boolean",
        currentValue: enabled,
    };
}

export const DEFAULT_COLLABORATION_MODE: ModeKind = "default";
export const PLAN_COLLABORATION_MODE: ModeKind = "plan";

export function collaborationModeConfigOption(current: ModeKind): acp.SessionConfigOption {
    return {
        configId: COLLABORATION_MODE_CONFIG_ID,
        name: "Collaboration mode",
        description: "How Codex collaborates on subsequent turns",
        category: "model_config",
        type: "select",
        currentValue: current,
        options: [
            {value: DEFAULT_COLLABORATION_MODE, name: "Default", description: "Make changes directly"},
            {value: PLAN_COLLABORATION_MODE, name: "Plan", description: "Plan before making changes"},
        ],
    };
}

export function parseCollaborationMode(value: unknown): ModeKind | undefined {
    if (value === DEFAULT_COLLABORATION_MODE) return DEFAULT_COLLABORATION_MODE;
    if (value === PLAN_COLLABORATION_MODE) return PLAN_COLLABORATION_MODE;
    return undefined;
}

function capitalize(value: string): string {
    return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
