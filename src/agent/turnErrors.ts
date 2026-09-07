import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {CodexErrorInfo} from "../app-server/v2";

type Failure = {stopReason: acp.StopReason; category: string; retryable: boolean};

export function classifyTurnError(info: CodexErrorInfo | null): Failure {
    const failure = (category: string, retryable = false, stopReason: acp.StopReason = "_error"): Failure => ({category, retryable, stopReason});
    if (info === null) return failure("unknown");
    if (typeof info === "object") {
        if ("activeTurnNotSteerable" in info) return failure("turn_not_steerable");
        const status = "httpConnectionFailed" in info ? info.httpConnectionFailed.httpStatusCode
            : "responseStreamConnectionFailed" in info ? info.responseStreamConnectionFailed.httpStatusCode
            : "responseStreamDisconnected" in info ? info.responseStreamDisconnected.httpStatusCode
            : info.responseTooManyFailedAttempts.httpStatusCode;
        return failure("connection", status === null || status === 408 || status === 429 || status >= 500);
    }
    switch (info) {
        case "contextWindowExceeded": return failure("context_window", false, "max_tokens");
        case "cyberPolicy":
        case "misalignmentPolicyViolation": return failure("policy", false, "refusal");
        case "sessionBudgetExceeded": return failure("budget");
        case "usageLimitExceeded": return failure("usage_limit");
        case "rateLimitExceeded": return failure("rate_limit", true);
        case "serverOverloaded": return failure("overloaded", true);
        case "internalServerError": return failure("internal", true);
        case "unauthorized": return failure("authentication");
        case "badRequest": return failure("invalid_request");
        case "threadRollbackFailed": return failure("rollback");
        case "sandboxError": return failure("sandbox");
        case "other": return failure("unknown");
    }
}
