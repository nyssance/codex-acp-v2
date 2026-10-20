import {once} from "node:events";
import {createServer, type Server} from "node:http";
import {zstdCompressSync} from "node:zlib";
import WebSocket, {WebSocketServer} from "ws";
import {afterEach, describe, expect, it} from "vitest";
import {ResponsesProxy} from "../codex/responsesProxy";

const foreign = {type: "reasoning", content: [{type: "reasoning_text", text: "foreign"}], summary: [], encrypted_content: "opaque"};
const message = {type: "message", role: "user", content: [{type: "input_text", text: "hello"}]};
const body = JSON.stringify({input: [foreign, message]});
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function listen(server: Server): Promise<string> {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => {server.closeAllConnections(); server.close();});
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    return `http://127.0.0.1:${address.port}`;
}
function proxy(): ResponsesProxy { const value = new ResponsesProxy(); cleanup.push(() => value.close()); return value; }
async function receive(socket: WebSocket): Promise<string> {
    const [data] = await once(socket, "message");
    return String(data);
}

describe("Responses compatibility transport", () => {
    it("decodes zstd, preserves auth and streams SSE through the original base path", async () => {
        const server = createServer(async (req, res) => {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            res.writeHead(200, {"content-type": "text/event-stream"});
            res.write(`data: ${JSON.stringify({path: req.url, auth: req.headers.authorization, account: req.headers["chatgpt-account-id"], encoding: req.headers["content-encoding"] ?? null, body: JSON.parse(Buffer.concat(chunks).toString())})}\n\n`);
            res.end("data: [DONE]\n\n");
        });
        const base = await listen(server);
        const route = await proxy().route(`${base}/backend-api/codex`);
        const response = await fetch(`${route}/responses`, {method: "POST", headers: {authorization: "Bearer test", "chatgpt-account-id": "account", "content-encoding": "zstd"}, body: new Uint8Array(zstdCompressSync(body))});
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(JSON.parse(text.split("\n")[0]!.slice(6))).toEqual({path: "/backend-api/codex/responses", auth: "Bearer test", account: "account", encoding: null, body: {input: [message]}});
        expect(text).toContain("data: [DONE]");
    });

    it("filters every websocket request, preserves incremental IDs and closes the upstream on cancellation", async () => {
        const server = createServer();
        const wss = new WebSocketServer({server}); cleanup.push(() => wss.close());
        let upstreamClosed: Promise<unknown> | undefined;
        wss.on("connection", (socket, req) => {
            upstreamClosed = once(socket, "close");
            socket.on("message", data => socket.send(JSON.stringify({body: JSON.parse(String(data)), auth: req.headers.authorization, path: req.url})));
        });
        const route = await proxy().route(await listen(server));
        const client = new WebSocket(`${route.replace("http:", "ws:")}/responses`, {headers: {authorization: "Bearer ws-test"}});
        cleanup.push(() => client.terminate());
        await once(client, "open");
        let received = receive(client); client.send(body);
        expect(JSON.parse(await received)).toEqual({body: {input: [message]}, auth: "Bearer ws-test", path: "/responses"});
        received = receive(client); client.send(JSON.stringify({type: "response.create", previous_response_id: "previous", input: [foreign, message]}));
        expect(JSON.parse(await received).body).toEqual({type: "response.create", previous_response_id: "previous", input: [message]});
        client.close(1000);
        await upstreamClosed;
    });

    it("forwards HTTP errors without retrying, and rejects unknown routes without upstream traffic", async () => {
        let calls = 0;
        const server = createServer((_req, res) => { calls++; res.writeHead(429, {"retry-after": "7"}).end('rate limited'); });
        const route = await proxy().route(await listen(server));
        const response = await fetch(`${route}/responses`, {method: "POST", body});
        expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("7"); expect(await response.text()).toBe("rate limited");
        const forbidden = await fetch(`${new URL(route).origin}/unknown/responses`, {method: "POST", body});
        expect(forbidden.status).toBe(404); expect(calls).toBe(1);
    });

    it.each([401, 429, 426])("preserves upstream websocket handshake status %s and retry headers", async status => {
        const server = createServer();
        server.on("upgrade", (_request, socket) => socket.end(`HTTP/1.1 ${status} Rejected\r\nRetry-After: 7\r\nContent-Length: 8\r\nConnection: close\r\n\r\nrejected`));
        const route = await proxy().route(await listen(server));
        const client = new WebSocket(`${route.replace("http:", "ws:")}/responses`);
        cleanup.push(() => client.terminate());
        const result = await new Promise<{status: number | undefined; retry: string | undefined; body: string}>((resolve, reject) => {
            client.on("error", reject);
            client.on("open", () => reject(new Error("Proxy accepted a rejected upstream handshake")));
            client.on("unexpected-response", (_request, response) => {
                const chunks: Buffer[] = [];
                response.on("data", (data: Buffer) => chunks.push(data));
                response.on("end", () => resolve({status: response.statusCode, retry: response.headers["retry-after"], body: Buffer.concat(chunks).toString()}));
            });
        });
        expect(result).toEqual({status, retry: "7", body: "rejected"});
    });

    it("aborts upstream HTTP streaming when the downstream is cancelled", async () => {
        let disconnected: Promise<unknown> | undefined;
        const server = createServer((_req, res) => {
            disconnected = once(res, "close");
            res.writeHead(200, {"content-type": "text/event-stream"}); res.write("data: first\n\n");
        });
        const route = await proxy().route(await listen(server));
        const abort = new AbortController();
        const response = await fetch(`${route}/responses`, {method: "POST", body, signal: abort.signal});
        expect((await response.body!.getReader().read()).done).toBe(false);
        abort.abort();
        await disconnected;
    });

    it("closes listeners and active websocket connections when disposed", async () => {
        const server = createServer(); const wss = new WebSocketServer({server}); cleanup.push(() => wss.close());
        const value = proxy(); const route = await value.route(await listen(server));
        const client = new WebSocket(`${route.replace("http:", "ws:")}/responses`); cleanup.push(() => client.terminate());
        await once(client, "open"); const closed = once(client, "close"); value.close(); await closed;
        await expect(fetch(`${route}/responses`, {method: "POST", body})).rejects.toThrow();
        await expect(value.route("https://api.openai.com/v1")).rejects.toThrow(/closed/);
    });
});
