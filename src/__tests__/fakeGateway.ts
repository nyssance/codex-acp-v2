import http from "node:http";
import type {AddressInfo} from "node:net";

/**
 * Minimal OpenAI Responses API server for tests: answers every `POST /responses`
 * with a streamed assistant message, records the requests it saw, and rejects
 * calls without the expected bearer token. Enough for Codex to complete a turn.
 */
export interface GatewayRequest {
    path: string;
    authorization: string | null;
    body: Record<string, unknown>;
}

export interface FakeGateway {
    readonly baseUrl: string;
    readonly requests: GatewayRequest[];
    close(): Promise<void>;
}

export function startFakeGateway(options: {token: string; reply: string}): Promise<FakeGateway> {
    const requests: GatewayRequest[] = [];
    const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", chunk => chunks.push(chunk as Buffer));
        request.on("end", () => {
            const path = request.url ?? "/";
            const authorization = request.headers.authorization ?? null;
            let body: Record<string, unknown> = {};
            try {
                body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
            } catch {
                body = {};
            }
            requests.push({path, authorization, body});
            if (authorization !== `Bearer ${options.token}`) {
                response.writeHead(401, {"content-type": "application/json"});
                response.end(JSON.stringify({error: {message: "bad token", type: "invalid_request_error"}}));
                return;
            }
            if (!path.endsWith("/responses")) {
                response.writeHead(404, {"content-type": "application/json"});
                response.end(JSON.stringify({error: {message: `no route ${path}`}}));
                return;
            }
            response.writeHead(200, {"content-type": "text/event-stream", "cache-control": "no-cache"});
            response.end(responsesStream(options.reply, typeof body["model"] === "string" ? body["model"] : "unknown"));
        });
    });
    return new Promise(resolve => {
        server.listen(0, "127.0.0.1", () => {
            const {port} = server.address() as AddressInfo;
            resolve({
                baseUrl: `http://127.0.0.1:${port}/v1`,
                requests,
                close: () => new Promise(done => server.close(() => done())),
            });
        });
    });
}

function responsesStream(text: string, model: string): string {
    const item = {type: "message", id: "msg_fake", role: "assistant", status: "completed", content: [{type: "output_text", text, annotations: []}]};
    const response = {
        id: "resp_fake",
        object: "response",
        model,
        status: "completed",
        output: [item],
        usage: {input_tokens: 12, input_tokens_details: {cached_tokens: 0}, output_tokens: 3, output_tokens_details: {reasoning_tokens: 0}, total_tokens: 15},
    };
    const events: Array<[string, Record<string, unknown>]> = [
        ["response.created", {type: "response.created", sequence_number: 0, response: {...response, status: "in_progress", output: []}}],
        ["response.output_item.added", {type: "response.output_item.added", sequence_number: 1, output_index: 0, item: {...item, status: "in_progress", content: []}}],
        ["response.content_part.added", {type: "response.content_part.added", sequence_number: 2, item_id: "msg_fake", output_index: 0, content_index: 0, part: {type: "output_text", text: "", annotations: []}}],
        ["response.output_text.delta", {type: "response.output_text.delta", sequence_number: 3, item_id: "msg_fake", output_index: 0, content_index: 0, delta: text}],
        ["response.output_text.done", {type: "response.output_text.done", sequence_number: 4, item_id: "msg_fake", output_index: 0, content_index: 0, text}],
        ["response.content_part.done", {type: "response.content_part.done", sequence_number: 5, item_id: "msg_fake", output_index: 0, content_index: 0, part: {type: "output_text", text, annotations: []}}],
        ["response.output_item.done", {type: "response.output_item.done", sequence_number: 6, output_index: 0, item}],
        ["response.completed", {type: "response.completed", sequence_number: 7, response}],
    ];
    return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}
