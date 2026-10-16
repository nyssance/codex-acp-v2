import {expect, it} from "vitest";
import {createTestAgent, itemCompleted, THREAD_ID, turnCompleted} from "./harness";
import {turn} from "./fixtures";
import {historyUpdates} from "../agent/history";
import type {ThreadItem} from "../app-server/v2";

const answer: ThreadItem = {type: "agentMessage", id: "answer", text: "Looks fine.", phase: null, memoryCitation: null, delivery: null, questions: null};
const review: ThreadItem = {type: "exitedReviewMode", id: "review", review: "Looks fine."};

it("emits the review conclusion from the assistant message Codex sends after the exit", async () => {
    const t = createTestAgent();
    await t.initialize();
    await t.openSession();
    await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/review"}]});
    await t.settle();
    t.client.clear();
    itemCompleted(t.codex, review, "review-turn");
    itemCompleted(t.codex, answer, "review-turn");
    await t.settle();
    expect(t.client.updatesOf("agent_message")).toMatchObject([{messageId: "answer", content: [{text: "Looks fine."}]}]);
    turnCompleted(t.codex, {id: "review-turn"});
    await t.settle();
    expect(t.client.updatesOf("agent_message").every(update => update.messageId === "answer")).toBe(true);
});

it("replays and exports review turns without the exit marker", async () => {
    expect(historyUpdates([turn({items: [review, answer]})])).toMatchObject([{sessionUpdate: "agent_message", messageId: "answer"}]);
    const t = createTestAgent();
    await t.initialize();
    t.codex.respond("thread/turns/list", () => ({data: [turn({items: [review, answer]})], nextCursor: null, backwardsCursor: null}));
    const history = await t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID});
    expect(history.turns[0]?.updates).toMatchObject([{sessionUpdate: "agent_message", messageId: "answer"}]);
    expect(history.turns[0]?.updates).toHaveLength(1);
});
