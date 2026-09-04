import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {parsePatch, structuredPatch} from "diff";
import type {FileUpdateChange} from "../app-server/v2";

/**
 * Converts one Codex file change into ACP v2 diff content: an authoritative
 * `changes` list plus a git-style unified patch. Codex delivers full file
 * content for additions and deletions, and a unified diff for updates.
 */
export function diffContent(change: FileUpdateChange): acp.ToolCallContent {
    switch (change.kind.type) {
        case "add":
            return {
                type: "diff",
                changes: [{operation: "add", path: change.path}],
                patch: {format: "git_patch", text: gitPatch(null, change.path, "", change.diff)},
            };
        case "delete":
            return {
                type: "diff",
                changes: [{operation: "delete", path: change.path}],
                patch: {format: "git_patch", text: gitPatch(change.path, null, change.diff, "")},
            };
        case "update": {
            const movePath = change.kind.move_path;
            const changes: acp.DiffChange[] = movePath && movePath !== change.path
                ? [{operation: "move", oldPath: change.path, path: movePath}]
                : [{operation: "modify", path: change.path}];
            return {
                type: "diff",
                changes,
                patch: {format: "git_patch", text: normalizeUnifiedDiff(stripMoveSuffix(change.diff), change.path, movePath ?? change.path)},
            };
        }
    }
}

export function changePaths(changes: readonly FileUpdateChange[]): string[] {
    const paths = new Set<string>();
    for (const change of changes) {
        paths.add(change.path);
        if (change.kind.type === "update" && change.kind.move_path) paths.add(change.kind.move_path);
    }
    return [...paths];
}

/** Renders a git-style unified patch; a null path means the file did not exist on that side. */
export function gitPatch(oldPath: string | null, newPath: string | null, oldText: string, newText: string): string {
    const patch = structuredPatch(oldPath ?? "", newPath ?? "", oldText, newText, undefined, undefined, {context: 3});
    const header = [`--- ${oldPath ?? "/dev/null"}`, `+++ ${newPath ?? "/dev/null"}`];
    const hunks = patch.hunks.map(hunk => [
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...hunk.lines,
    ].join("\n"));
    return ensureTrailingNewline([...header, ...hunks].join("\n"));
}

/** Codex appends a synthetic "Moved to:" trailer to the unified diff of a renamed file. */
function stripMoveSuffix(diff: string): string {
    return diff.replace(/\n\nMoved to: .*$/, "");
}

/** Ensures the patch carries `---`/`+++` headers so git-patch consumers can parse it. */
function normalizeUnifiedDiff(diff: string, oldPath: string, newPath: string): string {
    const trimmed = diff.replace(/^\s*\n/, "");
    if (/^---\s/m.test(trimmed) && /^\+\+\+\s/m.test(trimmed)) return ensureTrailingNewline(trimmed);
    const body = trimmed.startsWith("@@") ? trimmed : parseHunksOrRaw(trimmed);
    return ensureTrailingNewline(`--- ${oldPath}\n+++ ${newPath}\n${body}`);
}

function parseHunksOrRaw(diff: string): string {
    try {
        const [patch] = parsePatch(diff);
        if (patch && patch.hunks.length > 0) {
            return patch.hunks.map(hunk => [
                `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
                ...hunk.lines,
            ].join("\n")).join("\n");
        }
    } catch {
        // fall through and hand the client whatever Codex produced
    }
    return diff;
}

function ensureTrailingNewline(text: string): string {
    return text.endsWith("\n") ? text : `${text}\n`;
}
