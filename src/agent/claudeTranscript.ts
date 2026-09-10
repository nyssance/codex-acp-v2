/**
 * Claude Code transcript (`<projects>/<project-key>/<sessionId>.jsonl`) → Codex rollout.
 *
 * ALwith keeps one platform session record in Claude Code's JSONL format for every engine.
 * Resuming such a record in Codex means giving Codex a rollout file whose thread id *is* the
 * record id, so `thread/resume` restores the whole model context natively and every later
 * turn is appended to that same rollout. This module produces that file; it does not touch
 * the platform record.
 *
 * Model-visible history is carried as `response_item` lines: user/assistant messages, images,
 * and every tool call with its result as `function_call` / `function_call_output` pairs. The
 * tool names stay foreign (`Read`, `Bash`, dsh plugin tools); the Responses API keeps prior
 * calls as history without requiring them in the current tool set. Thinking blocks are not
 * carried: Anthropic signatures are only valid for the model that produced them.
 *
 * `event_msg` lines (`task_started` / `user_message` / `agent_message` / `task_complete`) are
 * emitted alongside so Codex's own turn projection (`thread/turns/list`, previews) sees the
 * conversation too. Lines Codex cannot parse are skipped by its loader, never fatal.
 */

export interface ClaudeTranscriptLine {
    type?: string;
    subtype?: string;
    uuid?: string;
    timestamp?: string;
    cwd?: string;
    isMeta?: boolean;
    isCompactSummary?: boolean;
    messageUuid?: string;
    status?: string;
    alwith?: {delivery?: string; projected?: boolean};
    message?: {role?: string; content?: string | ClaudeContentBlock[]};
}

export type ClaudeContentBlock =
    | {type: "text"; text: string}
    | {type: "thinking"; thinking: string}
    | {type: "image"; source: {type?: string; media_type?: string; data?: string}}
    | {type: "tool_use"; id: string; name: string; input?: unknown}
    | {type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean}
    | {type: string};

/** Wire shapes of the rollout `response_item` payloads this module writes. */
export type RolloutResponseItem =
    | {type: "message"; role: "user" | "assistant"; content: Array<{type: "input_text" | "output_text"; text: string} | {type: "input_image"; image_url: string}>}
    | {type: "function_call"; name: string; arguments: string; call_id: string}
    | {type: "function_call_output"; call_id: string; output: string};

export interface RolloutOptions {
    /** Thread id of the rollout; for ALwith this is the platform record id (a UUID). */
    threadId: string;
    /** Working directory recorded in `session_meta`; overrides the transcript's own `cwd`. */
    cwd?: string;
    /** `session_meta.originator`, e.g. the adapter's package name. */
    originator: string;
    /** `session_meta.cli_version`; Codex records its own version here, hosts record theirs. */
    cliVersion: string;
    /** Clock for lines without a transcript timestamp. */
    now?: () => Date;
    /** Turn id generator (UUIDs); injectable for deterministic tests. */
    turnId?: () => string;
}

export interface RolloutConversion {
    /** Newline-terminated rollout JSONL. */
    text: string;
    /** `session_meta.timestamp`; the rollout filename derives from it. */
    createdAt: Date;
    /** Model-visible items in order, for hosts that inject instead of writing a file. */
    items: RolloutResponseItem[];
    cwd: string;
    turns: number;
}

/** Parses transcript JSONL into message lines, keeping the last version of each uuid in its first position. */
export function parseClaudeTranscript(text: string): ClaudeTranscriptLine[] {
    const lines: ClaudeTranscriptLine[] = [];
    const positions = new Map<string, number>();
    const sent = new Set<string>();
    const raw = text.split("\n");
    for (let index = 0; index < raw.length; index += 1) {
        const line = raw[index]!.trim();
        if (!line) continue;
        let parsed: ClaudeTranscriptLine;
        try {
            parsed = JSON.parse(line) as ClaudeTranscriptLine;
        } catch (error) {
            // Only the final line may be a partial write in progress.
            if (index === raw.length - 1 || (index === raw.length - 2 && raw[raw.length - 1] === "")) continue;
            throw new Error(`Claude transcript line ${index + 1} is not JSON: ${String(error)}`);
        }
        if (parsed.type === "acpDelivery" && parsed.status === "sent" && parsed.messageUuid) sent.add(parsed.messageUuid);
        if (parsed.type !== "user" && parsed.type !== "assistant") continue;
        if (parsed.isMeta === true) continue;
        if (parsed.uuid) {
            const position = positions.get(parsed.uuid);
            if (position !== undefined) {
                lines[position] = parsed;
                continue;
            }
            positions.set(parsed.uuid, lines.length);
        }
        lines.push(parsed);
    }
    // A prompt whose delivery to the engine was never confirmed is not history the model saw.
    return lines.filter(line => line.alwith?.delivery !== "intent" || (line.uuid !== undefined && sent.has(line.uuid)));
}

/** Text form of a tool result: strings as-is, text blocks joined, anything else as JSON. */
function toolResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map(block => (typeof block === "object" && block !== null && (block as {type?: unknown}).type === "text" ? String((block as {text?: unknown}).text ?? "") : JSON.stringify(block)))
            .join("\n");
    }
    if (content === undefined || content === null) return "";
    return JSON.stringify(content);
}

/** Turns one transcript line into rollout response items, in block order. */
export function transcriptLineItems(line: ClaudeTranscriptLine): RolloutResponseItem[] {
    const role = line.type === "assistant" ? "assistant" : "user";
    const content = line.message?.content;
    if (content === undefined || content === null) return [];
    const textType = role === "assistant" ? "output_text" : "input_text";
    if (typeof content === "string") {
        return content.trim() ? [{type: "message", role, content: [{type: textType, text: content}]}] : [];
    }
    const items: RolloutResponseItem[] = [];
    let message: Extract<RolloutResponseItem, {type: "message"}> | null = null;
    const flush = () => {
        if (message && message.content.length > 0) items.push(message);
        message = null;
    };
    const part = () => (message ??= {type: "message", role, content: []});
    for (const block of content) {
        switch (block.type) {
            case "text": {
                const text = (block as {text: string}).text;
                if (text.trim()) part().content.push({type: textType, text});
                break;
            }
            case "image": {
                const source = (block as {source: {media_type?: string; data?: string}}).source;
                if (source.data) part().content.push({type: "input_image", image_url: `data:${source.media_type ?? "image/png"};base64,${source.data}`});
                break;
            }
            case "tool_use": {
                flush();
                const tool = block as {id: string; name: string; input?: unknown};
                items.push({type: "function_call", name: tool.name, arguments: JSON.stringify(tool.input ?? {}), call_id: tool.id});
                break;
            }
            case "tool_result": {
                flush();
                const result = block as {tool_use_id: string; content?: unknown; is_error?: boolean};
                const text = toolResultText(result.content);
                items.push({type: "function_call_output", call_id: result.tool_use_id, output: result.is_error ? `Error: ${text}` : text});
                break;
            }
            case "thinking":
            default:
                break;
        }
    }
    flush();
    return items;
}

function messageText(item: RolloutResponseItem): string {
    if (item.type !== "message") return "";
    return item.content.flatMap(part => ("text" in part ? [part.text] : [])).join("\n");
}

/** Converts a Claude Code transcript into a Codex rollout for `threadId`. */
export function claudeTranscriptToRollout(text: string, options: RolloutOptions): RolloutConversion {
    const now = options.now ?? (() => new Date());
    const turnId = options.turnId ?? (() => crypto.randomUUID());
    const lines = parseClaudeTranscript(text);
    const cwd = options.cwd ?? lines.find(line => typeof line.cwd === "string")?.cwd;
    if (!cwd) throw new Error("Claude transcript has no cwd and none was provided");
    const firstTimestamp = lines.find(line => line.timestamp)?.timestamp;
    const createdAt = firstTimestamp ? new Date(firstTimestamp) : now();
    if (Number.isNaN(createdAt.getTime())) throw new Error(`Claude transcript has an invalid timestamp: ${firstTimestamp}`);

    const out: string[] = [];
    const items: RolloutResponseItem[] = [];
    const push = (timestamp: string, type: string, payload: unknown) => out.push(JSON.stringify({timestamp, type, payload}));
    const stamp = (line: ClaudeTranscriptLine) => line.timestamp ?? now().toISOString();

    push(createdAt.toISOString(), "session_meta", {
        session_id: options.threadId,
        id: options.threadId,
        timestamp: createdAt.toISOString(),
        cwd,
        originator: options.originator,
        cli_version: options.cliVersion,
    });

    let turn: {id: string; startedAt: string; lastAgentMessage: string | null} | null = null;
    let turns = 0;
    const closeTurn = (timestamp: string) => {
        if (!turn) return;
        const started = Math.floor(new Date(turn.startedAt).getTime() / 1000);
        const completed = Math.floor(new Date(timestamp).getTime() / 1000);
        push(timestamp, "event_msg", {
            type: "task_complete",
            turn_id: turn.id,
            last_agent_message: turn.lastAgentMessage,
            started_at: started,
            completed_at: completed,
            duration_ms: Math.max(0, (completed - started) * 1000),
        });
        turn = null;
    };

    for (const line of lines) {
        const lineItems = transcriptLineItems(line);
        if (lineItems.length === 0) continue;
        const timestamp = stamp(line);
        const isPrompt = line.type === "user" && lineItems.some(item => item.type === "message");
        if (isPrompt) {
            closeTurn(timestamp);
            turn = {id: turnId(), startedAt: timestamp, lastAgentMessage: null};
            turns += 1;
            push(timestamp, "event_msg", {type: "task_started", turn_id: turn.id, started_at: Math.floor(new Date(timestamp).getTime() / 1000), model_context_window: null});
            const prompt = lineItems.find(item => item.type === "message");
            push(timestamp, "event_msg", {type: "user_message", message: prompt ? messageText(prompt) : "", local_images: [], text_elements: []});
        }
        for (const item of lineItems) {
            push(timestamp, "response_item", item);
            items.push(item);
            if (item.type === "message" && item.role === "assistant" && turn) {
                const message = messageText(item);
                if (message) {
                    turn.lastAgentMessage = message;
                    push(timestamp, "event_msg", {type: "agent_message", message, phase: null});
                }
            }
        }
    }
    closeTurn(lines.length > 0 ? stamp(lines[lines.length - 1]!) : createdAt.toISOString());

    return {text: `${out.join("\n")}\n`, createdAt, items, cwd, turns};
}

/** `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<threadId>.jsonl`, relative to `CODEX_HOME`. */
export function rolloutRelativePath(threadId: string, createdAt: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    const year = createdAt.getUTCFullYear();
    const month = pad(createdAt.getUTCMonth() + 1);
    const day = pad(createdAt.getUTCDate());
    const stamp = `${year}-${month}-${day}T${pad(createdAt.getUTCHours())}-${pad(createdAt.getUTCMinutes())}-${pad(createdAt.getUTCSeconds())}`;
    return `sessions/${year}/${month}/${day}/rollout-${stamp}-${threadId}.jsonl`;
}
