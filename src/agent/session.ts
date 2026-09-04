import type {Account, Model} from "../app-server/v2";
import type {ModeKind} from "../app-server/ModeKind";
import type {AgentMode} from "../codex/modes";
import type {ModelSelection} from "../codex/models";
import type {TokenCount} from "../util/tokens";

export interface ActiveTurn {
    /** Codex turn id; null until `turn/start` has returned. */
    turnId: string | null;
    /** Thread that owns the turn. Review turns run on a separate review thread. */
    threadId: string;
    readonly abort: AbortController;
    /** Resolves with the turn id once known, or null when the turn never started. */
    readonly started: Promise<string | null>;
    resolveStarted(turnId: string | null): void;
    /** Resolves once the prompt flow has emitted its terminal state update. */
    readonly finished: Promise<void>;
    resolveFinished(): void;
}

export interface Session {
    readonly id: string;
    cwd: string;
    additionalDirectories: string[];
    /** Sanitized names of MCP servers the client asked for on this session. */
    mcpServerNames: string[];
    catalog: Model[];
    model: ModelSelection;
    mode: AgentMode;
    collaborationMode: ModeKind;
    fastMode: boolean;
    account: Account | null;
    title: string | null;
    /** Explicit titles come from Codex thread names and are never overwritten by prompt fallbacks. */
    titleIsExplicit: boolean;
    activeTurn: ActiveTurn | null;
    lastUsage: TokenCount | null;
    contextWindow: number | null;
    closed: boolean;
}

export function createActiveTurn(threadId: string): ActiveTurn {
    let resolveStarted: (turnId: string | null) => void = () => {};
    let resolveFinished: () => void = () => {};
    const started = new Promise<string | null>(resolve => {
        resolveStarted = resolve;
    });
    const finished = new Promise<void>(resolve => {
        resolveFinished = resolve;
    });
    let startedSettled = false;
    let finishedSettled = false;
    return {
        turnId: null,
        threadId,
        abort: new AbortController(),
        started,
        resolveStarted(turnId) {
            if (startedSettled) return;
            startedSettled = true;
            resolveStarted(turnId);
        },
        finished,
        resolveFinished() {
            if (finishedSettled) return;
            finishedSettled = true;
            resolveFinished();
        },
    };
}
