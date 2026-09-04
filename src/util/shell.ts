/** Removes a `bash -lc '...'` style wrapper so titles show the command the user recognizes. */
export function stripShellPrefix(command: string): string {
    const withoutShell = command.replace(/^(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/, "");
    if (withoutShell.length >= 2 && withoutShell.startsWith("'") && withoutShell.endsWith("'")) {
        return withoutShell.slice(1, -1);
    }
    return withoutShell;
}
