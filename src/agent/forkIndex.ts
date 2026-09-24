import {createReadStream} from "node:fs";
import {readdir, realpath} from "node:fs/promises";
import path from "node:path";
import {createInterface} from "node:readline";
import type {Thread} from "../app-server/v2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = new Set(["cli", "vscode", "exec", "appServer", "unknown"]);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Codex 0.156 omits empty-preview forks from thread/list, even after continuation.
 * Read only native rollout headers to discover IDs, then ask thread/read for authoritative
 * summaries. Never write Codex files or maintain a separate conversation index.
 */
export async function nativeForks(
    codexHome: string,
    archived: boolean,
    cwd: string | null,
    read: (id: string) => Promise<Thread>,
): Promise<Thread[]> {
    const root = path.join(codexHome, archived ? "archived_sessions" : "sessions");
    const wantedCwd = cwd === null ? null : await realpath(cwd).catch(error => {
        if (missing(error)) return cwd;
        throw error;
    });
    const result: Thread[] = [];
    for await (const file of rolloutFiles(root)) {
        const header = await firstLine(file);
        if (header === null) continue; // Deletion/archive may race a list.
        let value: unknown;
        try { value = JSON.parse(header); } catch { continue; } // A partially written rollout has no committed metadata yet.
        if (!value || typeof value !== "object" || !("type" in value) || value.type !== "session_meta" || !("payload" in value)) continue;
        const meta = value.payload as Record<string, unknown> | null;
        if (!meta || typeof meta["id"] !== "string" || !UUID.test(meta["id"])
            || typeof meta["forked_from_id"] !== "string" || !UUID.test(meta["forked_from_id"])
            || typeof meta["source"] !== "string" || !SOURCES.has(meta["source"])
            || (wantedCwd !== null && meta["cwd"] !== wantedCwd && meta["cwd"] !== cwd)) continue;
        // Ensure the file still belongs to this active/archive collection before surfacing it.
        const thread = await read(meta["id"]).catch(async error => {
            try { await realpath(file); } catch (statError) { if (missing(statError)) return null; }
            throw error;
        });
        if (thread && thread.forkedFromId !== null) {
            try { await realpath(file); } catch (error) { if (missing(error)) continue; throw error; }
            result.push(cwd === null ? thread : {...thread, cwd});
        }
    }
    return result;
}

async function* rolloutFiles(directory: string): AsyncGenerator<string> {
    let entries;
    try { entries = await readdir(directory, {withFileTypes: true}); }
    catch (error) { if (missing(error)) return; throw error; }
    for (const entry of entries) {
        const file = path.join(directory, entry.name);
        // Do not follow symlinks out of Codex's native history directories.
        if (entry.isDirectory()) yield* rolloutFiles(file);
        else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) yield file;
    }
}

async function firstLine(file: string): Promise<string | null> {
    const stream = createReadStream(file, {encoding: "utf8"});
    const lines = createInterface({input: stream, crlfDelay: Infinity});
    try {
        for await (const line of lines) return line;
        return null;
    } catch (error) { if (missing(error)) return null; throw error; }
    finally { lines.close(); stream.destroy(); }
}
