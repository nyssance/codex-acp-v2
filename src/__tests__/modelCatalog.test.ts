import {chmodSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {EXTRA_MODEL_CATALOGS_ENV, mergedModelCatalog} from "../codex/process";

function fakeCodex(models: unknown[]): {command: string; prefixArgs: string[]; shell: boolean} {
    const directory = mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
    const command = path.join(directory, "codex");
    writeFileSync(command, `#!/bin/sh\nif [ "$1 $2" = "debug models" ]; then cat <<'JSON'\n${JSON.stringify({models})}\nJSON\nelse exit 2; fi\n`);
    chmodSync(command, 0o755);
    return {command, prefixArgs: [], shell: false};
}

function catalogFile(models: unknown[]): string {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "extra-catalog-")), "models.json");
    writeFileSync(file, JSON.stringify({models}));
    return file;
}

describe.skipIf(process.platform === "win32")("mergedModelCatalog", () => {
    it("is null without extra catalogs, so Codex keeps its own table", () => {
        expect(mergedModelCatalog(fakeCodex([]), {})).toBeNull();
    });

    it("keeps Codex's models and adds the extra ones hidden, without duplicating known slugs", () => {
        const launcher = fakeCodex([{slug: "gpt-6.1-sol", visibility: "list"}, {slug: "gpt-5.5", visibility: "list"}]);
        const extra = catalogFile([{slug: "deepseek-flash", visibility: "list", context_window: 1}, {slug: "gpt-5.5", visibility: "list", context_window: 2}]);
        const merged = mergedModelCatalog(launcher, {[EXTRA_MODEL_CATALOGS_ENV]: extra});
        expect(merged).not.toBeNull();
        const models = JSON.parse(readFileSync(merged as string, "utf8")).models as Array<Record<string, unknown>>;
        expect(models.map(model => model["slug"])).toEqual(["gpt-6.1-sol", "gpt-5.5", "deepseek-flash"]);
        expect(models[1]).toEqual({slug: "gpt-5.5", visibility: "list"});
        expect(models[2]).toEqual({slug: "deepseek-flash", visibility: "hide", context_window: 1});
    });

    it("fails loudly when Codex cannot dump its catalog or an extra file is malformed", () => {
        const broken = {command: "/nonexistent/codex", prefixArgs: [], shell: false};
        expect(() => mergedModelCatalog(broken, {[EXTRA_MODEL_CATALOGS_ENV]: catalogFile([])})).toThrow(/codex debug models failed/);
        expect(() => mergedModelCatalog(fakeCodex([]), {[EXTRA_MODEL_CATALOGS_ENV]: catalogFile([{visibility: "list"}])})).toThrow(/without a slug/);
    });
});
