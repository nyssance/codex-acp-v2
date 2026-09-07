import readline from "node:readline";
import {model, threadResponse, turn} from "./fixtures";

if (process.argv.includes("--version")) {
    console.log("codex-cli 0.153.0");
    process.exit(0);
}
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({input: process.stdin}).on("line", line => {
    const {id, method, params} = JSON.parse(line);
    if (id === undefined) return;
    let result: unknown;
    switch (method) {
        case "initialize": result = {userAgent: "fixture", codexHome: process.cwd(), platformFamily: "unix", platformOs: process.platform}; break;
        case "account/read": result = {account: null, requiresOpenaiAuth: false}; break;
        case "skills/list": result = {data: []}; break;
        case "skills/extraRoots/set": result = {}; break;
        case "config/read": result = {config: {}, layers: [], origins: {}}; break;
        case "model/list": result = {data: [model()], nextCursor: null}; break;
        case "thread/start": result = threadResponse({cwd: params.cwd}); break;
        case "thread/unsubscribe": result = {}; break;
        case "turn/start":
            result = {turn: turn({status: "inProgress"})};
            send({id, result});
            send({method: "item/completed", params: {threadId: params.threadId, turnId: "turn-1", completedAtMs: 0, item: {type: "agentMessage", id: "answer", text: "你好 🌍 fixture", phase: "final_answer", memoryCitation: null, delivery: null, questions: null}}});
            send({method: "turn/completed", params: {threadId: params.threadId, turn: turn()}});
            return;
        default: send({id, error: {code: -32601, message: `Unscripted fixture request: ${method}`}}); return;
    }
    send({id, result});
});
