import type {Model, Thread, Turn} from "../app-server/v2";

export const THREAD_ID = "thread-1";
export const TURN_ID = "turn-1";
export const CWD = "/workspace/project";

export function model(overrides: Partial<Model> = {}): Model {
    return {
        id: "gpt-5",
        model: "gpt-5",
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: "GPT-5",
        description: "Flagship model",
        modelSpecialty: null,
        hidden: false,
        supportedReasoningEfforts: [
            {reasoningEffort: "low", description: "Fast"},
            {reasoningEffort: "medium", description: "Balanced"},
            {reasoningEffort: "high", description: "Thorough"},
        ],
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
        supportsPersonality: false,
        multiAgentVersion: null,
        additionalSpeedTiers: [],
        serviceTiers: [{id: "fast", name: "Fast", description: "1.5x speed"}],
        defaultServiceTier: null,
        isDefault: true,
        ...overrides,
    };
}

export function thread(overrides: Partial<Thread> = {}): Thread {
    return {
        id: THREAD_ID,
        sessionId: THREAD_ID,
        forkedFromId: null,
        parentThreadId: null,
        preview: "",
        ephemeral: false,
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "full",
        modelProvider: "openai",
        model: "gpt-5",
        reasoningEffort: "medium",
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_100,
        recencyAt: null,
        status: {type: "idle"},
        path: null,
        cwd: CWD,
        cliVersion: "0.153.0",
        source: "cli",
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
        ...overrides,
    } as Thread;
}

export function turn(overrides: Partial<Turn> = {}): Turn {
    return {
        id: TURN_ID,
        items: [],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        ...overrides,
    };
}

export function threadResponse(overrides: Partial<Thread> = {}) {
    const loaded = thread(overrides);
    return {
        thread: loaded,
        model: loaded.model ?? "gpt-5",
        modelProvider: "openai",
        serviceTier: null,
        cwd: loaded.cwd,
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false},
        reasoningEffort: loaded.reasoningEffort,
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
    };
}
