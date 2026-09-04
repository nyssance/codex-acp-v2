import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {TokenUsageBreakdown} from "../app-server/v2";

/** Token usage for one turn, decoupled from Codex's wire shape. */
export interface TokenCount {
    totalTokens: number;
    /** Non-cached input tokens. Codex counts cached input inside inputTokens; it is split out here. */
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
}

export function toTokenCount(usage: TokenUsageBreakdown): TokenCount {
    return {
        totalTokens: usage.totalTokens,
        inputTokens: usage.inputTokens - usage.cachedInputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
    };
}

export function toAcpUsage(count: TokenCount): acp.Usage {
    return {
        totalTokens: count.totalTokens,
        inputTokens: count.inputTokens,
        outputTokens: count.outputTokens,
        thoughtTokens: count.reasoningOutputTokens,
        cachedReadTokens: count.cachedInputTokens,
        cachedWriteTokens: count.cacheWriteInputTokens,
    };
}

export function formatTokenCount(count: number): string {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return count.toString();
}
