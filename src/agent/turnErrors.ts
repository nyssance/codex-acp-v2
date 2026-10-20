import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {CodexErrorInfo} from "../app-server/v2";

export type StopReason = Extract<acp.IdleStateUpdate, {stopReason: "end_turn" | "cancelled" | "error" | "max_tokens" | "max_turn_requests" | "refusal"}>["stopReason"];

type Failure = {stopReason: StopReason; category: string; retryable: boolean};

const CONNECTION_FAILURES = ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"] as const;

export function classifyTurnError(info: CodexErrorInfo | null): Failure {
    const failure = (category: string, retryable = false, stopReason: StopReason = "error"): Failure => ({category, retryable, stopReason});
    if (info === null) return failure("unknown");
    if (typeof info === "object") {
        if ("activeTurnNotSteerable" in info) return failure("turn_not_steerable");
        const status = connectionStatus(info);
        if (status === undefined) return failure("unknown");
        return failure("connection", status === null || status === 408 || status === 429 || status >= 500);
    }
    switch (info) {
        case "contextWindowExceeded": return failure("context_window", false, "max_tokens");
        case "cyberPolicy":
        case "misalignmentPolicyViolation": return failure("policy", false, "refusal");
        // Codex ends the turn after too many permission denials; retrying asks the same questions again.
        case "tooManyDenials": return failure("too_many_denials");
        case "sessionBudgetExceeded": return failure("budget");
        case "usageLimitExceeded": return failure("usage_limit");
        case "rateLimitExceeded": return failure("rate_limit", true);
        case "serverOverloaded": return failure("overloaded", true);
        case "flexUnavailable": return failure("flex_unavailable", true);
        case "internalServerError": return failure("internal", true);
        case "unauthorized": return failure("authentication");
        case "badRequest": return failure("invalid_request");
        case "threadRollbackFailed": return failure("rollback");
        case "sandboxError": return failure("sandbox");
        case "other": return failure("unknown");
    }
    // Codex serializes every variant it has no name for as "other"; the open string and object
    // arms of the generated type exist only for its deserializer.
    return failure("unknown");
}

function connectionStatus(info: object): number | null | undefined {
    for (const key of CONNECTION_FAILURES) {
        if (key in info) return (info as Record<typeof key, {httpStatusCode: number | null}>)[key].httpStatusCode;
    }
    return undefined;
}
