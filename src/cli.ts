import os from "node:os";
import path from "node:path";
import process from "node:process";

import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

import {
  DEFAULT_RECOVERY_BYTES,
  DEFAULT_RECOVERY_DAYS,
  MAX_VAULTS,
  SERVER_VERSION
} from "./constants.js";
import { Runtime } from "./runtime.js";
import { buildServer } from "./server.js";
import {
  argsForDisplay,
  type Diagnostic,
  UserFacingError,
  writeDiagnostic
} from "./utils/diagnostics.js";
import { ToolFailure } from "./utils/errors.js";
import { Logger, type LogLevel } from "./utils/logger.js";
import { VaultRegistry, type VaultDefinition } from "./utils/vault.js";

type Command = "serve" | "doctor" | "recovery-list" | "recovery-restore";

interface CliOptions {
  command: Command;
  vaults: VaultDefinition[];
  recoveryDays: number;
  recoveryMaxBytes: number;
  logLevel: LogLevel;
  legacy: "serve" | "reject";
  canonicalArgs: string[];
  warnings: Diagnostic[];
  recoveryId?: string;
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments([...args]);
  if (parsed === "help") {
    process.stdout.write(helpText());
    return;
  }
  if (parsed === "version") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  for (const warning of parsed.warnings) writeDiagnostic("warning", warning);

  const logger = new Logger(parsed.logLevel);
  const registry = await VaultRegistry.create(parsed.vaults);
  const runtime = new Runtime(
    registry,
    { recoveryDays: parsed.recoveryDays, recoveryMaxBytes: parsed.recoveryMaxBytes },
    logger
  );
  try {
    await runtime.initialize();
  } catch (error) {
    if (
      error instanceof ToolFailure &&
      typeof error.details?.lock_path === "string" &&
      error.details.lock_path === ".obsidian-mcp/locks/write"
    ) {
      const remediation = error.details.remediation;
      throw new UserFacingError(
        {
          code: error.code,
          problem: "Obsidian MCP could not safely acquire the vault write lock.",
          detected: error.message,
          fix:
            typeof remediation === "string"
              ? [
                  "Stop every obsidian-mcp process using this vault.",
                  "Open the vault root in a terminal.",
                  `Run: ${remediation}`
                ]
              : error.code === "LOCK_TIMEOUT"
                ? "Wait for the reported holder to finish, or stop that process before retrying."
                : "Confirm this process can create, rename, and remove entries in the vault's .obsidian-mcp/locks directory.",
          verify: "Run the same vault configuration with 'obsidian-mcp doctor'.",
          helpAnchor: "write-lock-recovery"
        },
        1,
        { cause: error }
      );
    }
    throw error;
  }

  if (parsed.command === "doctor") {
    process.stdout.write(
      `${JSON.stringify({ ok: true, vaults: await runtime.doctor() }, null, 2)}\n`
    );
    return;
  }
  if (parsed.command === "recovery-list") {
    const result = Object.fromEntries(
      await Promise.all(
        registry
          .ids()
          .map(async (id) => [id, await runtime.forVault(id).transactions.listRecovery()] as const)
      )
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (parsed.command === "recovery-restore") {
    if (parsed.recoveryId === undefined) {
      throw usageError(
        "CLI_MISSING_RECOVERY_ID",
        "Recovery restore requires a transaction id.",
        "No --id value was supplied.",
        ["Add --id <transaction-id> to the recovery restore command."],
        "recovery-changes"
      );
    }
    if (registry.ids().length !== 1) {
      throw usageError(
        "CLI_RECOVERY_VAULT_COUNT",
        "Recovery restore operates on exactly one configured vault.",
        `${registry.ids().length} vaults were configured.`,
        "Run the command again with one --vault id=/absolute/path argument.",
        "recovery-changes"
      );
    }
    const vaultId = registry.ids()[0];
    if (vaultId === undefined) throw new Error("Missing vault after validation.");
    const transactionId = await runtime
      .forVault(vaultId)
      .transactions.restoreRecovery(parsed.recoveryId);
    process.stdout.write(
      `${JSON.stringify({ ok: true, transaction_id: transactionId }, null, 2)}\n`
    );
    return;
  }

  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 10 * 1024 * 1024
  });
  let warnedLegacyClient = false;
  let reportedStrictRejection = false;
  const handle = serveStdio(
    ({ era }) => {
      if (era === "legacy" && !warnedLegacyClient) {
        warnedLegacyClient = true;
        writeDiagnostic("warning", legacyProtocolWarning(parsed.canonicalArgs));
      }
      return buildServer(runtime);
    },
    {
      legacy: parsed.legacy,
      transport,
      onerror: (error) => {
        if (
          parsed.legacy === "reject" &&
          error.message.includes("Rejected 2025-era request") &&
          !reportedStrictRejection
        ) {
          reportedStrictRejection = true;
          writeDiagnostic("error", strictProtocolDiagnostic(parsed.canonicalArgs));
          return;
        }
        logger.log("error", "stdio_error", { message: error.message });
      }
    }
  );
  logger.log("info", "server_started", { vaults: registry.ids(), version: SERVER_VERSION });
  let closing = false;
  const close = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.log("info", "server_stopping", { signal });
    await handle.close();
  };
  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));
}

export function parseArguments(args: string[]): CliOptions | "help" | "version" {
  if (args.includes("--help") || args[0] === "help") return "help";
  if (args.includes("--version")) return "version";
  if (args.length > 0 && args[0] !== undefined && !isCommandToken(args[0])) {
    const first = args[0];
    const commandSuggestion = closest(first, ["serve", "doctor", "recovery"]);
    if (looksLikePath(first) || editDistance(first, commandSuggestion) > 2) {
      return parseLegacyPositional(args);
    }
  }

  const first = args.shift();
  let command: Command;
  if (first === "serve" || first === "doctor") command = first;
  else if (first === "recovery") {
    const recoveryCommand = args.shift();
    if (recoveryCommand === "list") command = "recovery-list";
    else if (recoveryCommand === "restore") command = "recovery-restore";
    else {
      throw usageError(
        "CLI_UNKNOWN_RECOVERY_COMMAND",
        "The recovery subcommand is missing or unknown.",
        recoveryCommand ?? "No recovery subcommand supplied.",
        ["Use 'recovery list' or 'recovery restore'.", usageLine()],
        "diagnostic-reference"
      );
    }
  } else {
    const suggestion =
      first === undefined ? "serve" : closest(first, ["serve", "doctor", "recovery"]);
    throw usageError(
      "CLI_UNKNOWN_COMMAND",
      "The command is missing or unknown.",
      first ?? "No command supplied.",
      [
        `Did you mean '${suggestion}'?`,
        usageLine(),
        "For an old v1 configuration, keep the vault path as the first argument and the server will show its replacement."
      ],
      "diagnostic-reference"
    );
  }

  const vaults: VaultDefinition[] = [];
  let recoveryDays = DEFAULT_RECOVERY_DAYS;
  let recoveryMaxBytes = DEFAULT_RECOVERY_BYTES;
  let logLevel: LogLevel = "info";
  let legacy: CliOptions["legacy"] = "serve";
  let recoveryId: string | undefined;
  let sawVaultFlag = false;
  const canonicalArgs = commandArgs(command);
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === undefined) break;
    if (!flag.startsWith("--")) {
      throw usageError(
        sawVaultFlag ? "CLI_MIXED_CONFIG_SYNTAX" : "CLI_UNEXPECTED_POSITIONAL_ARGUMENT",
        sawVaultFlag
          ? "Positional vault paths cannot be mixed with --vault arguments."
          : "This v2 command received an unexpected positional argument.",
        flag,
        [
          `Use only: ${argsForDisplay([...canonicalArgs, "--vault", "notes=/absolute/path/to/vault"])}`,
          'Or use only positional paths temporarily: ["/absolute/path/to/vault"]'
        ],
        "v1-positional-vault-paths"
      );
    }
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) {
      throw usageError(
        "CLI_MISSING_OPTION_VALUE",
        `Option '${flag}' requires a value.`,
        value === undefined
          ? "The command ended before a value was supplied."
          : `Found '${value}'.`,
        `Supply a value after ${flag}. Run 'obsidian-mcp --help' for examples.`,
        "diagnostic-reference"
      );
    }
    if (flag === "--vault") {
      sawVaultFlag = true;
      const vault = parseVault(value);
      vaults.push(vault);
      canonicalArgs.push(flag, `${vault.id}=${vault.root}`);
    } else if (flag === "--recovery-days") {
      recoveryDays = parsePositiveInteger(value, flag);
      canonicalArgs.push(flag, value);
    } else if (flag === "--recovery-max-bytes") {
      recoveryMaxBytes = parsePositiveInteger(value, flag);
      canonicalArgs.push(flag, value);
    } else if (flag === "--log-level" && isLogLevel(value)) {
      logLevel = value;
      canonicalArgs.push(flag, value);
    } else if (flag === "--log-level") {
      throw usageError(
        "CLI_INVALID_LOG_LEVEL",
        "The log level is invalid.",
        value,
        "Use one of: error, warn, info, debug.",
        "diagnostic-reference"
      );
    } else if (flag === "--legacy" && isLegacyMode(value)) {
      legacy = value;
      canonicalArgs.push(flag, value);
    } else if (flag === "--legacy") {
      throw usageError(
        "CLI_INVALID_LEGACY_MODE",
        "The legacy protocol mode is invalid.",
        value,
        "Use '--legacy serve' for broad compatibility or '--legacy reject' for modern-only clients.",
        "legacy-mcp-clients"
      );
    } else if (flag === "--id") {
      recoveryId = value;
      canonicalArgs.push(flag, value);
    } else {
      const suggestion = closest(flag, [
        "--vault",
        "--recovery-days",
        "--recovery-max-bytes",
        "--log-level",
        "--legacy",
        "--id"
      ]);
      throw usageError(
        "CLI_UNKNOWN_OPTION",
        "The command contains an unknown option.",
        flag,
        [`Did you mean '${suggestion}'?`, "Run 'obsidian-mcp --help' to list supported options."],
        "diagnostic-reference"
      );
    }
  }
  if (vaults.length === 0) {
    throw usageError(
      "CLI_VAULT_REQUIRED",
      "At least one Obsidian vault must be configured.",
      "No --vault argument was supplied.",
      `Use: ${argsForDisplay([...commandArgs(command), "--vault", "notes=/absolute/path/to/vault"])}`,
      "v1-positional-vault-paths"
    );
  }
  if (vaults.length > MAX_VAULTS) {
    throw usageError(
      "CLI_TOO_MANY_VAULTS",
      `At most ${MAX_VAULTS} vaults may be configured.`,
      `${vaults.length} vaults were supplied.`,
      `Remove vault arguments until no more than ${MAX_VAULTS} remain.`,
      "diagnostic-reference"
    );
  }
  return {
    command,
    vaults,
    recoveryDays,
    recoveryMaxBytes,
    logLevel,
    legacy,
    canonicalArgs,
    warnings: [],
    ...(recoveryId === undefined ? {} : { recoveryId })
  };
}

function parseLegacyPositional(args: string[]): CliOptions {
  const flag = args.find((arg) => arg.startsWith("--"));
  if (flag !== undefined) {
    throw usageError(
      "CLI_MIXED_CONFIG_SYNTAX",
      "Positional vault paths cannot be mixed with v2 options.",
      `Found positional paths together with '${flag}'.`,
      [
        "Use only positional vault paths temporarily, or migrate every path to --vault id=/absolute/path.",
        'Example: ["serve", "--vault", "notes=/absolute/path/to/vault"]'
      ],
      "v1-positional-vault-paths"
    );
  }
  if (args.length > MAX_VAULTS) {
    throw usageError(
      "CLI_TOO_MANY_VAULTS",
      `At most ${MAX_VAULTS} vaults may be configured.`,
      `${args.length} positional paths were supplied.`,
      `Remove paths until no more than ${MAX_VAULTS} remain.`,
      "diagnostic-reference"
    );
  }
  const roots = args.map(expandLegacyPath);
  const ids = uniqueVaultIds(roots);
  const vaults = roots.map((root, index) => ({ id: ids[index] ?? "vault", root }));
  const canonicalArgs = ["serve"];
  for (const vault of vaults) canonicalArgs.push("--vault", `${vault.id}=${vault.root}`);
  const mappings = vaults.map((vault) => `${vault.root} -> ${vault.id}`);
  return {
    command: "serve",
    vaults,
    recoveryDays: DEFAULT_RECOVERY_DAYS,
    recoveryMaxBytes: DEFAULT_RECOVERY_BYTES,
    logLevel: "info",
    legacy: "serve",
    canonicalArgs,
    warnings: [
      {
        code: "V1_POSITIONAL_CONFIG_DEPRECATED",
        problem:
          "This v1 positional vault configuration still works, but it will become invalid in a future release.",
        detected: mappings,
        fix: [
          "Replace the MCP server args with:",
          argsForDisplay(canonicalArgs),
          "Restart the MCP client after saving the configuration."
        ],
        verify: argsForDisplay(["doctor", ...canonicalArgs.slice(1)]),
        helpAnchor: "v1-positional-vault-paths"
      }
    ]
  };
}

function parseVault(value: string): VaultDefinition {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw usageError(
      "CLI_INVALID_VAULT_ARGUMENT",
      "The --vault value is malformed.",
      value,
      [
        "Use the form id=/absolute/path.",
        'Example: ["serve", "--vault", "notes=/absolute/path/to/vault"]'
      ],
      "v1-positional-vault-paths"
    );
  }
  return { id: value.slice(0, separator), root: value.slice(separator + 1) };
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw usageError(
      "CLI_INVALID_POSITIVE_INTEGER",
      `${flag} requires a positive integer.`,
      value,
      `Replace '${value}' with a whole number greater than zero.`,
      "diagnostic-reference"
    );
  }
  return parsed;
}

function expandLegacyPath(value: string): string {
  const expanded =
    value === "~"
      ? os.homedir()
      : value.startsWith(`~${path.sep}`) || value.startsWith("~/")
        ? path.join(os.homedir(), value.slice(2))
        : value;
  return path.resolve(expanded);
}

function uniqueVaultIds(roots: readonly string[]): string[] {
  const used = new Set<string>();
  return roots.map((root) => {
    const initial = vaultIdFromPath(root);
    let id = initial;
    let suffix = 2;
    while (used.has(id)) {
      const ending = `-${suffix}`;
      id = `${initial.slice(0, 64 - ending.length).replace(/[-_]+$/u, "")}${ending}`;
      suffix += 1;
    }
    used.add(id);
    return id;
  });
}

function vaultIdFromPath(root: string): string {
  let id = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-");
  id = id.replace(/^[-_]+|[-_]+$/gu, "");
  if (id.length === 0) id = "vault";
  if (!/^[a-z]/u.test(id)) id = `vault-${id}`;
  return id.slice(0, 64).replace(/[-_]+$/u, "") || "vault";
}

function usageError(
  code: string,
  problem: string,
  detected: string | readonly string[],
  fix: string | readonly string[],
  helpAnchor: string
): UserFacingError {
  return new UserFacingError({ code, problem, detected, fix, helpAnchor }, 2);
}

function legacyProtocolWarning(canonicalArgs: readonly string[]): Diagnostic {
  return {
    code: "LEGACY_MCP_PROTOCOL",
    problem:
      "The connected MCP client uses the 2025-era protocol. It is supported for now but will become unsupported in a future release.",
    detected: "A legacy initialize handshake was received.",
    fix: [
      "Upgrade the MCP client or host to one that negotiates MCP 2026-07-28.",
      "Keep the current configuration until the client upgrade is complete."
    ],
    verify: `After upgrading, strict mode should connect with args ${argsForDisplay(withLegacyMode(canonicalArgs, "reject"))}`,
    helpAnchor: "legacy-mcp-clients"
  };
}

function strictProtocolDiagnostic(canonicalArgs: readonly string[]): Diagnostic {
  return {
    code: "STRICT_PROTOCOL_REJECTION",
    problem: "Modern-only mode rejected a client using the 2025-era MCP protocol.",
    detected:
      "The client opened with a legacy initialize handshake while --legacy reject is active.",
    fix: [
      "Upgrade the MCP client to MCP 2026-07-28, or temporarily allow compatibility with:",
      argsForDisplay(withLegacyMode(canonicalArgs, "serve"))
    ],
    verify: "Restart the MCP client and confirm the server appears and lists tools.",
    helpAnchor: "legacy-mcp-clients"
  };
}

function withLegacyMode(args: readonly string[], mode: "serve" | "reject"): string[] {
  const result = [...args];
  const index = result.indexOf("--legacy");
  if (index >= 0) result.splice(index, 2, "--legacy", mode);
  else result.push("--legacy", mode);
  return result;
}

function commandArgs(command: Command): string[] {
  if (command === "recovery-list") return ["recovery", "list"];
  if (command === "recovery-restore") return ["recovery", "restore"];
  return [command];
}

function isCommandToken(value: string): boolean {
  return value === "serve" || value === "doctor" || value === "recovery";
}

function looksLikePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function isLogLevel(value: string): value is LogLevel {
  return value === "error" || value === "warn" || value === "info" || value === "debug";
}

function isLegacyMode(value: string): value is CliOptions["legacy"] {
  return value === "serve" || value === "reject";
}

function closest(value: string, candidates: readonly string[]): string {
  return [...candidates].sort((a, b) => editDistance(value, a) - editDistance(value, b))[0] ?? "";
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + substitution
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function usageLine(): string {
  return "Usage: obsidian-mcp serve --vault notes=/absolute/path/to/vault";
}

function helpText(): string {
  return `obsidian-mcp ${SERVER_VERSION}

Usage:
  obsidian-mcp serve --vault <id>=<absolute-path> [--vault ...] [--legacy serve|reject]
  obsidian-mcp doctor --vault <id>=<absolute-path> [--vault ...]
  obsidian-mcp recovery list --vault <id>=<absolute-path> [--vault ...]
  obsidian-mcp recovery restore --vault <id>=<absolute-path> --id <transaction-id>

Compatibility:
  obsidian-mcp <vault-path> [vault-path ...]  Deprecated v1 syntax; prints replacement args

Options:
  --vault <id>=<path>          Configure one vault (required, repeatable, maximum 10)
  --recovery-days <days>       Completed journal retention (default: 30)
  --recovery-max-bytes <bytes> Recovery storage limit (default: 1073741824)
  --log-level <level>          error, warn, info, or debug
  --legacy <mode>              2025-era client handling: serve (default) or reject
  --help                       Show help
  --version                    Show version
`;
}
