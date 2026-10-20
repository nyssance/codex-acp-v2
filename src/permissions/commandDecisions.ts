import type { CommandExecutionApprovalDecision, CommandExecutionRequestApprovalParams } from "../app-server/v2"

/**
 * Returns the ordered decisions Codex offers for a command approval, or undefined when the
 * set is missing or names an amendment Codex did not propose. Codex always advertises the set;
 * an incomplete one fails closed instead of inventing choices.
 */
export function availableCommandDecisions(
  params: CommandExecutionRequestApprovalParams
): CommandExecutionApprovalDecision[] | undefined {
  const decisions = params.availableDecisions
  if (!decisions || decisions.length === 0) return undefined
  return decisions.every((decision) => proposed(decision, params)) ? decisions : undefined
}

function proposed(decision: CommandExecutionApprovalDecision, params: CommandExecutionRequestApprovalParams): boolean {
  if (typeof decision === "string") return true
  if ("acceptWithExecpolicyAmendment" in decision) {
    const amendment = decision.acceptWithExecpolicyAmendment.execpolicy_amendment
    return amendment.length > 0 && sameStrings(amendment, params.proposedExecpolicyAmendment)
  }
  const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment
  return (
    amendment.host === params.networkApprovalContext?.host &&
    (params.proposedNetworkPolicyAmendments ?? []).some(
      (entry) => entry.host === amendment.host && entry.action === amendment.action
    )
  )
}

function sameStrings(left: readonly string[], right?: readonly string[] | null): boolean {
  return !!right && left.length === right.length && left.every((value, index) => value === right[index])
}

/** Renders an exec-policy prefix the way the Codex TUI does, unwrapping `bash -lc` scripts. */
export function renderExecPolicyPrefix(command: readonly string[]): string {
  const script = extractWrappedScript(command)
  if (script !== undefined) return script
  if (command.some((value) => value.includes("\0"))) return command.join(" ")
  return command.map(shlexQuote).join(" ")
}

function extractWrappedScript(command: readonly string[]): string | undefined {
  const executable = executableName(command[0])
  if (
    (executable === "bash" || executable === "zsh" || executable === "sh") &&
    command.length === 3 &&
    (command[1] === "-lc" || command[1] === "-c")
  ) {
    return command[2]
  }
  if (executable !== "pwsh" && executable !== "powershell") return undefined
  const allowedFlags = new Set(["-nologo", "-noprofile", "-command", "-c"])
  for (let index = 1; index + 1 < command.length; index++) {
    const flag = command[index]?.toLowerCase()
    if (flag === undefined || !allowedFlags.has(flag)) return undefined
    if (flag === "-command" || flag === "-c") return command[index + 1]
  }
  return undefined
}

function executableName(command: string | undefined): string | undefined {
  let filename = command?.replaceAll("\\", "/").split("/").at(-1)
  while (filename !== undefined) {
    if (["bash", "zsh", "sh", "pwsh", "powershell"].includes(filename)) return filename
    const dot = filename.lastIndexOf(".")
    if (dot <= 0) return undefined
    filename = filename.slice(0, dot)
  }
  return undefined
}

function shlexQuote(value: string): string {
  if (value.length === 0) return "''"
  if (/^[0-9A-Za-z+\-./:@_]+$/.test(value)) return value
  if (!value.includes("'")) return `'${value}'`
  return `"${value.replace(/["\\$`!]/g, "\\$&")}"`
}
