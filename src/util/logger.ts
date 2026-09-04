import fs from "node:fs";
import path from "node:path";

type LogContext = Record<string, unknown>;

/**
 * Append-only file logger. Enabled only when `APP_SERVER_LOGS` names a directory;
 * stdout is the ACP transport, so nothing is ever written there.
 */
class Logger {
    private readonly logFilePath: string | null;

    constructor(logDir = process.env["APP_SERVER_LOGS"]) {
        if (!logDir) {
            this.logFilePath = null;
            return;
        }
        try {
            fs.mkdirSync(logDir, {recursive: true});
            this.logFilePath = path.join(logDir, "codex-acp-v2.log");
            this.log("logger initialized", {logFilePath: this.logFilePath});
        } catch (error) {
            console.error("Failed to initialize log directory", error);
            this.logFilePath = null;
        }
    }

    get enabled(): boolean {
        return this.logFilePath !== null;
    }

    log(message: string, context?: LogContext): void {
        if (this.logFilePath === null) return;
        try {
            const line = `${timestamp()} ${message} ${JSON.stringify({pid: process.pid, ...context})}`;
            fs.appendFileSync(this.logFilePath, `${line}\n`);
        } catch (error) {
            console.error("Logger write failed", error);
        }
    }

    error(message: string, error: unknown, context?: LogContext): void {
        this.log(`[error] ${message}`, {...context, error: formatError(error)});
    }
}

function timestamp(): string {
    return new Date().toISOString();
}

export function formatError(error: unknown): string {
    if (error instanceof Error) {
        const parts = [`${error.name}: ${error.message}`];
        if (error.stack) parts.push(error.stack);
        if ("cause" in error && error.cause) parts.push(`Caused by: ${formatError(error.cause)}`);
        return parts.join("\n");
    }
    if (typeof error === "string") return error;
    return String(error);
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return String(error);
}

export const logger = new Logger();
