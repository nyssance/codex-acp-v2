import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {AppServerClient} from "../codex/AppServerClient";
import {findAgentMode, MODE_CONFIG_ID, modeConfigOption} from "../codex/modes";
import {
    COLLABORATION_MODE_CONFIG_ID,
    coerceEffort,
    collaborationModeConfigOption,
    EFFORT_CONFIG_ID,
    effortConfigOption,
    FAST_MODE_CONFIG_ID,
    fastModeConfigOption,
    findModel,
    MODEL_CONFIG_ID,
    modelConfigOption,
    modelSupportsFast,
    parseCollaborationMode,
    supportedEfforts,
} from "../codex/models";
import type {Session} from "./session";

export function sessionConfigOptions(session: Session): acp.SessionConfigOption[] {
    const model = findModel(session.catalog, session.model.model);
    const options = [
        modeConfigOption(session.mode),
        modelConfigOption(session.catalog, session.model.model),
        effortConfigOption(supportedEfforts(model), session.model.effort),
        collaborationModeConfigOption(session.collaborationMode),
    ];
    if (modelSupportsFast(model)) options.push(fastModeConfigOption(session.fastMode));
    return options;
}

/**
 * The single place a config option takes effect. Model, effort, fast mode and
 * mode are turn parameters and only update session state; collaboration mode
 * is a thread setting and is pushed to Codex immediately.
 */
export async function applyConfigOption(
    session: Session,
    codex: AppServerClient,
    request: acp.SetSessionConfigOptionRequest,
): Promise<void> {
    switch (request.configId) {
        case MODE_CONFIG_ID: {
            const mode = findAgentMode(stringValue(request));
            if (!mode) throw acp.RequestError.invalidParams({configId: request.configId}, `Unknown mode "${String(request.value)}"`);
            session.mode = mode;
            return;
        }
        case MODEL_CONFIG_ID: {
            const modelId = stringValue(request);
            const model = findModel(session.catalog, modelId);
            session.model = {model: modelId, effort: coerceEffort(model, session.model.effort)};
            if (!modelSupportsFast(model)) session.fastMode = false;
            return;
        }
        case EFFORT_CONFIG_ID: {
            const effort = stringValue(request);
            const model = findModel(session.catalog, session.model.model);
            const efforts = supportedEfforts(model);
            if (efforts.length > 0 && !efforts.some(option => option.reasoningEffort === effort)) {
                throw acp.RequestError.invalidParams({configId: request.configId}, `Model ${session.model.model} does not support effort "${effort}"`);
            }
            session.model = {...session.model, effort};
            return;
        }
        case FAST_MODE_CONFIG_ID: {
            if (request.type !== "boolean" || typeof request.value !== "boolean") {
                throw acp.RequestError.invalidParams({configId: request.configId}, "fast_mode expects a boolean value");
            }
            if (request.value && !modelSupportsFast(findModel(session.catalog, session.model.model))) {
                throw acp.RequestError.invalidParams({configId: request.configId}, `Model ${session.model.model} does not support fast mode`);
            }
            session.fastMode = request.value;
            return;
        }
        case COLLABORATION_MODE_CONFIG_ID: {
            const mode = parseCollaborationMode(stringValue(request));
            if (!mode) throw acp.RequestError.invalidParams({configId: request.configId}, `Unknown collaboration mode "${String(request.value)}"`);
            await codex.threadSettingsUpdate({
                threadId: session.id,
                collaborationMode: {
                    mode,
                    settings: {model: session.model.model, reasoning_effort: session.model.effort, developer_instructions: null},
                },
            });
            session.collaborationMode = mode;
            return;
        }
        default:
            throw acp.RequestError.invalidParams({configId: request.configId}, `Unknown config option "${request.configId}"`);
    }
}

function stringValue(request: acp.SetSessionConfigOptionRequest): string {
    if (typeof request.value !== "string" || request.value.length === 0) {
        throw acp.RequestError.invalidParams({configId: request.configId}, `Config option "${request.configId}" expects a string value`);
    }
    return request.value;
}
