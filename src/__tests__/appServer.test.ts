import {describe, expect, it, vi} from "vitest";
import {AppServerClient} from "../codex/AppServerClient";
import {FakeCodexConnection} from "./harness";

describe("app-server notification lifetimes", () => {
    it("removes an aborted notification waiter before later notifications", async () => {
        const connection = new FakeCodexConnection();
        const codex = new AppServerClient(connection.asMessageConnection());
        const scope = new AbortController();
        const matches = vi.fn(() => true);
        const completed = codex.awaitNotification("thread/compacted", matches, scope.signal);
        scope.abort(new Error("cancelled"));
        await expect(completed).rejects.toThrow("cancelled");
        connection.emit({method: "thread/compacted", params: {threadId: "t", turnId: "turn"}});
        expect(matches).not.toHaveBeenCalled();
    });

    it("cleans up a notification scope when its triggering request fails", async () => {
        const connection = new FakeCodexConnection();
        const codex = new AppServerClient(connection.asMessageConnection());
        let old: Promise<unknown> | undefined;
        await expect(codex.withNotification("account/updated", async completed => {
            old = completed;
            throw new Error("logout failed");
        })).rejects.toThrow("logout failed");
        await expect(old).rejects.toThrow();
        const fresh = codex.awaitNotification("account/updated");
        const params = {authMode: null, planType: null};
        connection.emit({method: "account/updated", params});
        await expect(fresh).resolves.toEqual(params);
    });

    it("rejects notification and MCP startup waits on disconnect", async () => {
        const connection = new FakeCodexConnection();
        const codex = new AppServerClient(connection.asMessageConnection());
        const notification = expect(codex.awaitNotification("account/updated")).rejects.toThrow("Connection to Codex was lost");
        const startup = expect(codex.awaitMcpStartup(["server"], 0)).rejects.toThrow("Connection to Codex was lost");
        connection.close();
        await Promise.all([notification, startup]);
    });

    it("can cancel one MCP startup waiter without cancelling another", async () => {
        const connection = new FakeCodexConnection();
        const codex = new AppServerClient(connection.asMessageConnection());
        const scope = new AbortController();
        const first = codex.awaitMcpStartup(["server"], 0, scope.signal);
        const second = codex.awaitMcpStartup(["server"], 0);
        scope.abort(new Error("session closed"));
        await expect(first).rejects.toThrow("session closed");
        connection.emit({method: "mcpServer/startupStatus/updated", params: {threadId: null, name: "server", status: "ready", error: null, failureReason: null}});
        await expect(second).resolves.toEqual({ready: ["server"], failed: [], cancelled: []});
    });

    it("does not apply one thread's MCP startup failure to another thread", async () => {
        const connection = new FakeCodexConnection();
        const codex = new AppServerClient(connection.asMessageConnection());
        const first = codex.awaitMcpStartup(["server"], 0, undefined, "first");
        const second = codex.awaitMcpStartup(["server"], 0, undefined, "second");
        const secondDone = vi.fn();
        void second.then(secondDone);
        connection.emit({method: "mcpServer/startupStatus/updated", params: {threadId: "first", name: "server", status: "failed", error: "unavailable", failureReason: null}});
        await expect(first).resolves.toEqual({ready: [], failed: [{server: "server", error: "unavailable"}], cancelled: []});
        expect(secondDone).not.toHaveBeenCalled();
        connection.emit({method: "mcpServer/startupStatus/updated", params: {threadId: "second", name: "server", status: "ready", error: null, failureReason: null}});
        await expect(second).resolves.toEqual({ready: ["server"], failed: [], cancelled: []});
    });
});
