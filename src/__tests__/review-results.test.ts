import {expect, it} from "vitest";
import {createTestAgent, itemCompleted, THREAD_ID, turnCompleted} from "./harness";
import {turn} from "./fixtures";
import {historyUpdates} from "../agent/history";
import type {ThreadItem} from "../app-server/v2";

const answer: ThreadItem = {type: "agentMessage", id: "answer", text: "Looks fine.", phase: "final_answer", memoryCitation: null, delivery: null, questions: null};
const review: ThreadItem = {type: "exitedReviewMode", id: "review", review: " Looks fine.\n"};

it.each([false, true])("emits a review conclusion once in either order (exit first: %s)", async exitFirst => {
    const t = createTestAgent();
    await t.initialize();
    await t.openSession();
    await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/review"}]});
    await t.settle();
    t.client.clear();
    for (const item of exitFirst ? [review, answer] : [answer, review]) itemCompleted(t.codex, item, "review-turn");
    itemCompleted(t.codex, {...review, id: "other-review", review: "Additional findings."}, "review-turn");
    await t.settle();
    expect(t.client.updatesOf("agent_message")).toHaveLength(1);
    expect(t.client.updatesOf("agent_message_chunk")).toHaveLength(0);
    turnCompleted(t.codex, {id: "review-turn"});
    await t.settle();
    expect(t.client.updatesOf("agent_message").filter(update => update.messageId === "other-review")).toMatchObject([{content: [{text: "Additional findings."}]}]);
    expect(t.client.updatesOf("agent_message").some(update => update.messageId === "review")).toBe(false);
    await t.agent.prompt({sessionId: THREAD_ID, prompt: [{type: "text", text: "/review"}]});
    await t.settle();
    t.client.clear();
    itemCompleted(t.codex, review, "review-turn");
    turnCompleted(t.codex, {id: "review-turn"});
    await t.settle();
    expect(t.client.updatesOf("agent_message")).toMatchObject([{messageId: "review"}]);
});

it("replays one conclusion per turn but preserves standalone exits and commentary", () => {
    expect(historyUpdates([turn({items: [answer, review]})]).filter(update => update.sessionUpdate === "agent_message")).toHaveLength(1);
    expect(historyUpdates([turn({items: [review]})])).toMatchObject([{sessionUpdate: "agent_message", messageId: "review"}]);
    expect(historyUpdates([turn({items: [{...answer, phase: "commentary"}, review]})])).toHaveLength(2);
    expect(historyUpdates([turn({items: [answer]}), turn({id: "next", items: [review]})])).toHaveLength(2);
});

it("exports full-turn review history without duplicating its conclusion", async () => {
    const t = createTestAgent();
    await t.initialize();
    t.codex.respond("thread/turns/list", () => ({data: [turn({items: [answer, review]})], nextCursor: null, backwardsCursor: null}));
    const history = await t.agent.sessionHistory({mode: "export", itemsView: "full", sessionId: THREAD_ID});
    expect(history.turns[0]?.updates).toMatchObject([{sessionUpdate: "agent_message", messageId: "answer"}]);
    expect(history.turns[0]?.updates).toHaveLength(1);
});
