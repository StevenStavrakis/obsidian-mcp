import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { ToolFailure, isNodeError } from "./errors.js";
import { sha256 } from "./hash.js";
import type { Logger } from "./logger.js";
import type { ResolvedVault } from "./vault.js";

const OWNER_LIMIT = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_ARTIFACT_RETENTION_MS = 7 * 86_400_000;
const LOCK_PATH = ".obsidian-mcp/locks/write";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type WriteLockLifecycleEvent =
  | "candidate_created"
  | "owner_opened"
  | "owner_written"
  | "before_publish"
  | "published"
  | "before_unpublish"
  | "unpublished";

export interface WriteLockDependencies {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  probePid?: (pid: number) => "alive" | "dead" | "unknown";
  rename?: (source: string, destination: string) => Promise<void>;
  lifecycle?: (event: WriteLockLifecycleEvent, path: string) => void | Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  artifactRetentionMs?: number;
}

interface VersionedOwner {
  version: 1;
  token: string;
  pid: number;
  started_at: string;
}

interface LegacyOwner {
  pid: number;
  started_at: string;
}

type ParsedOwner = VersionedOwner | LegacyOwner;

interface OwnerRecord {
  owner: ParsedOwner;
  raw: Buffer;
  identity: string;
}

interface Lease {
  owner: VersionedOwner;
  canonical: string;
}

type Inspection =
  | { kind: "missing" }
  | { kind: "changed" }
  | { kind: "empty" }
  | { kind: "owner"; record: OwnerRecord }
  | { kind: "corrupt"; reason: string; removable?: boolean; cause?: unknown };

class ReleaseFailure extends Error {
  constructor(
    message: string,
    readonly leaseStillPublished: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ReleaseFailure";
  }
}

const heldContexts = new AsyncLocalStorage<ReadonlySet<string>>();
const queues = new Map<string, Promise<void>>();
const poisonedLeases = new Map<string, Lease>();
const unprunableTombstones = new Set<string>();

export class WriteLock {
  private readonly locksRoot: string;
  private readonly canonical: string;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly probePid: (pid: number) => "alive" | "dead" | "unknown";
  private readonly rename: (source: string, destination: string) => Promise<void>;
  private readonly lifecycle: NonNullable<WriteLockDependencies["lifecycle"]>;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly artifactRetentionMs: number;

  constructor(
    private readonly vault: Pick<ResolvedVault, "id" | "root" | "stateRoot">,
    private readonly logger: Logger,
    dependencies: WriteLockDependencies = {}
  ) {
    this.locksRoot = path.join(vault.stateRoot, "locks");
    this.canonical = path.join(this.locksRoot, "write");
    this.now = dependencies.now ?? Date.now;
    this.sleep =
      dependencies.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.probePid = dependencies.probePid ?? probePid;
    this.rename = dependencies.rename ?? fs.rename;
    this.lifecycle = dependencies.lifecycle ?? (() => undefined);
    this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollMs = dependencies.pollMs ?? DEFAULT_POLL_MS;
    this.artifactRetentionMs = dependencies.artifactRetentionMs ?? DEFAULT_ARTIFACT_RETENTION_MS;
  }

  async runExclusive<T>(
    task: () => Promise<T>,
    operation: "startup" | "transaction" = "transaction"
  ): Promise<T> {
    if (heldContexts.getStore()?.has(this.vault.root) === true) {
      throw new ToolFailure(
        "TRANSACTION_FAILED",
        "Recursive write-lock acquisition was rejected before it could deadlock."
      );
    }

    return this.enqueue(async () => {
      await this.repairPoisonedLease();
      const lease = await this.acquire();
      const current = heldContexts.getStore() ?? new Set<string>();
      const held = new Set(current);
      held.add(this.vault.root);

      let value: T | undefined;
      let taskError: unknown;
      let taskFailed = false;
      let completed = false;
      try {
        value = await heldContexts.run(held, task);
        completed = true;
      } catch (error) {
        taskFailed = true;
        taskError = error;
      }

      try {
        await this.release(lease);
      } catch (error) {
        if (error instanceof ReleaseFailure && error.leaseStillPublished) {
          poisonedLeases.set(this.vault.root, lease);
        }
        throw this.releaseToolFailure(error, completed, operation, taskError);
      }

      if (taskFailed) {
        throw taskError instanceof Error ? taskError : new Error(String(taskError));
      }
      return value as T;
    });
  }

  async pruneArtifacts(): Promise<void> {
    if (heldContexts.getStore()?.has(this.vault.root) !== true) {
      throw new Error("Lock artifacts may only be pruned while holding the write lock.");
    }
    const entries = await fs.readdir(this.locksRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const artifact = path.join(this.locksRoot, entry.name);
      if (entry.name.startsWith(".write.released-")) {
        const token = entry.name.slice(".write.released-".length);
        const inspection = await this.inspect(artifact);
        if (
          inspection.kind === "owner" &&
          "token" in inspection.record.owner &&
          inspection.record.owner.token === token
        ) {
          await this.removeKnownDirectory(artifact, "write_lock_released_cleanup_failed");
        }
        continue;
      }
      if (entry.name.startsWith(".write.stale-")) {
        const identity = entry.name.slice(".write.stale-".length);
        if (unprunableTombstones.has(artifact)) continue;
        const stats = await lstatOptional(artifact);
        if (stats === undefined) continue;
        if (this.now() - stats.mtimeMs < this.artifactRetentionMs) continue;
        const inspection = await this.inspect(artifact);
        if (inspection.kind === "owner" && inspection.record.identity === identity) {
          await this.removeKnownDirectory(artifact, "write_lock_stale_cleanup_failed");
        }
        continue;
      }
      if (entry.name.startsWith(".write.pending-")) {
        const token = entry.name.slice(".write.pending-".length);
        const stats = await lstatOptional(artifact);
        if (stats === undefined) continue;
        const old = this.now() - stats.mtimeMs >= this.artifactRetentionMs;
        const inspection = await this.inspect(artifact);
        if (inspection.kind === "empty" && old) {
          await this.removeKnownDirectory(artifact, "write_lock_pending_cleanup_failed");
        } else if (
          inspection.kind === "owner" &&
          "token" in inspection.record.owner &&
          inspection.record.owner.token === token &&
          this.probePid(inspection.record.owner.pid) === "dead"
        ) {
          await this.removeKnownDirectory(artifact, "write_lock_pending_cleanup_failed");
        } else if (inspection.kind === "corrupt" && inspection.removable === true && old) {
          await this.removeKnownDirectory(artifact, "write_lock_pending_cleanup_failed");
        }
      }
    }
  }

  private async acquire(): Promise<Lease> {
    const owner: VersionedOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      started_at: new Date(this.now()).toISOString()
    };
    const candidate = path.join(this.locksRoot, `.write.pending-${owner.token}`);
    let candidateCreated = false;
    let published = false;
    try {
      await fs.mkdir(candidate, { mode: 0o700 });
      candidateCreated = true;
      await this.lifecycle("candidate_created", candidate);
      const handle = await fs.open(path.join(candidate, "owner.json"), "wx", 0o600);
      try {
        await this.lifecycle("owner_opened", candidate);
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      await this.lifecycle("owner_written", candidate);

      const started = this.now();
      let loggedContention = false;
      const logContention = () => {
        if (loggedContention) return;
        loggedContention = true;
        this.logger.log("debug", "write_lock_contention", {
          vault: this.vault.id,
          lock_path: LOCK_PATH
        });
      };
      while (true) {
        await this.lifecycle("before_publish", candidate);
        const existing = await this.inspect(this.canonical);
        if (existing.kind === "corrupt") {
          throw this.filesystemFailure(
            `The write lock is unsafe to replace: ${existing.reason}`,
            existing.cause
          );
        }
        if (existing.kind === "owner") {
          logContention();
          const liveness = this.probePid(existing.record.owner.pid);
          if (liveness === "dead") {
            await this.quarantineStale(existing.record);
            continue;
          }
          await this.waitOrTimeout(started, existing.record.owner.pid);
          continue;
        }
        if (existing.kind === "changed") {
          await this.waitOrTimeout(started);
          continue;
        }

        try {
          await this.rename(candidate, this.canonical);
          published = true;
          const lease = { owner, canonical: this.canonical };
          try {
            await this.lifecycle("published", this.canonical);
          } catch (error) {
            await this.release(lease);
            throw error;
          }
          this.logger.log("debug", "write_lock_acquired", {
            vault: this.vault.id,
            lock_path: LOCK_PATH,
            wait_ms: this.now() - started
          });
          return lease;
        } catch (error) {
          if (published) throw error;
          if (isNodeError(error) && error.code === "EXDEV") {
            throw this.filesystemFailure(
              "The write lock could not be published atomically across filesystem boundaries.",
              error
            );
          }
          if (!isPublishCollision(error)) throw this.publishFailure(error);
          if (isWindowsTransientRename(error)) {
            this.logger.log("debug", "write_lock_platform_retry", {
              vault: this.vault.id,
              lock_path: LOCK_PATH,
              code: error.code
            });
          }
          logContention();

          const inspection = await this.inspect(this.canonical);
          if (inspection.kind === "missing" || inspection.kind === "changed") {
            await this.waitOrTimeout(started);
            continue;
          }
          if (inspection.kind === "empty") {
            try {
              await fs.rmdir(this.canonical);
              this.logger.log("warn", "write_lock_empty_repaired", {
                vault: this.vault.id,
                lock_path: LOCK_PATH
              });
            } catch (repairError) {
              if (!isBenignRepairRace(repairError)) throw this.publishFailure(repairError);
            }
            await this.waitOrTimeout(started);
            continue;
          }
          if (inspection.kind === "corrupt") {
            throw this.filesystemFailure(
              `The write lock is unsafe to reclaim: ${inspection.reason}`,
              inspection.cause
            );
          }

          const liveness = this.probePid(inspection.record.owner.pid);
          if (liveness === "dead") {
            await this.quarantineStale(inspection.record);
            continue;
          }
          await this.waitOrTimeout(started, inspection.record.owner.pid);
        }
      }
    } catch (error) {
      if (candidateCreated && !published) {
        await this.removeKnownDirectory(candidate, "write_lock_candidate_cleanup_failed");
      }
      throw error;
    }
  }

  private async release(lease: Lease): Promise<void> {
    const before = await this.inspect(this.canonical);
    if (!matchesToken(before, lease.owner.token)) {
      throw new ReleaseFailure(
        "The canonical write lock is no longer owned by this process.",
        false
      );
    }

    const retired = path.join(this.locksRoot, `.write.released-${lease.owner.token}`);
    try {
      await this.lifecycle("before_unpublish", this.canonical);
    } catch (error) {
      throw new ReleaseFailure("Write-lock release was interrupted before unpublication.", true, {
        cause: error
      });
    }
    try {
      await this.renameForRelease(lease, retired);
    } catch (error) {
      if (error instanceof ReleaseFailure) throw error;
      throw new ReleaseFailure("The write lock could not be unpublished.", true, { cause: error });
    }
    await this.lifecycle("unpublished", retired);

    const after = await this.inspect(retired);
    if (!matchesToken(after, lease.owner.token)) {
      let restored = false;
      try {
        const canonical = await this.inspect(this.canonical);
        if (canonical.kind === "missing") {
          await this.rename(retired, this.canonical);
          restored = true;
        }
      } catch {
        restored = false;
      }
      this.logger.log("error", "write_lock_release_conflict", {
        vault: this.vault.id,
        lock_path: LOCK_PATH,
        restored
      });
      throw new ReleaseFailure(
        restored
          ? "A different lock was moved during release and has been restored."
          : "A different lock was moved during release and requires manual recovery.",
        false
      );
    }

    await this.removeKnownDirectory(retired, "write_lock_released_cleanup_failed");
  }

  private async repairPoisonedLease(): Promise<void> {
    const lease = poisonedLeases.get(this.vault.root);
    if (lease === undefined) return;
    try {
      await this.release(lease);
      poisonedLeases.delete(this.vault.root);
      this.logger.log("warn", "write_lock_poison_repaired", {
        vault: this.vault.id,
        lock_path: LOCK_PATH
      });
    } catch (error) {
      if (!(error instanceof ReleaseFailure && error.leaseStillPublished)) {
        poisonedLeases.delete(this.vault.root);
      }
      throw this.releaseToolFailure(error, false, "transaction");
    }
  }

  private async quarantineStale(record: OwnerRecord): Promise<void> {
    const retired = path.join(this.locksRoot, `.write.stale-${record.identity}`);
    try {
      await this.rename(this.canonical, retired);
    } catch (error) {
      if (isPublishCollision(error) || (isNodeError(error) && error.code === "ENOENT")) {
        const current = await this.inspect(this.canonical);
        if (current.kind === "owner" && current.record.raw.equals(record.raw)) {
          throw this.filesystemFailure(
            "A matching stale-lock tombstone already exists, so the canonical lock cannot be quarantined safely.",
            error
          );
        }
        return;
      }
      throw this.filesystemFailure("The stale write lock could not be quarantined.", error);
    }
    const moved = await this.inspect(retired);
    if (moved.kind === "owner" && moved.record.raw.equals(record.raw)) {
      const quarantinedAt = new Date(this.now());
      try {
        await fs.utimes(retired, quarantinedAt, quarantinedAt);
      } catch (error) {
        unprunableTombstones.add(retired);
        this.logger.log("warn", "write_lock_stale_timestamp_failed", {
          vault: this.vault.id,
          artifact: path.basename(retired),
          error: error instanceof Error ? error.message : String(error)
        });
      }
      this.logger.log("warn", "write_lock_stale_quarantined", {
        vault: this.vault.id,
        lock_path: LOCK_PATH,
        holding_pid: record.owner.pid
      });
      return;
    }

    let restored = false;
    try {
      const canonical = await this.inspect(this.canonical);
      if (canonical.kind === "missing") {
        await this.rename(retired, this.canonical);
        restored = true;
      }
    } catch {
      restored = false;
    }
    this.logger.log("error", "write_lock_quarantine_conflict", {
      vault: this.vault.id,
      lock_path: LOCK_PATH,
      restored
    });
    throw this.filesystemFailure("The stale write lock changed while it was being quarantined.");
  }

  private async inspect(directory: string): Promise<Inspection> {
    let directoryBefore;
    try {
      directoryBefore = await fs.lstat(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
      return { kind: "corrupt", reason: "the lock directory could not be inspected", cause: error };
    }
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      return { kind: "corrupt", reason: "the lock path is not a real directory" };
    }

    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { kind: "changed" };
      return { kind: "corrupt", reason: "the lock directory could not be read", cause: error };
    }
    if (entries.length === 0) return { kind: "empty" };
    if (entries.length !== 1 || entries[0] !== "owner.json") {
      return { kind: "corrupt", reason: "the lock directory contains unexpected entries" };
    }

    const ownerPath = path.join(directory, "owner.json");
    let ownerBefore;
    try {
      ownerBefore = await fs.lstat(ownerPath);
      if (ownerBefore.isSymbolicLink() || !ownerBefore.isFile()) {
        return { kind: "corrupt", reason: "owner.json is not a regular file" };
      }
      if (ownerBefore.size > OWNER_LIMIT) {
        return {
          kind: "corrupt",
          reason: `owner.json exceeds ${OWNER_LIMIT} bytes`,
          removable: true
        };
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { kind: "changed" };
      return { kind: "corrupt", reason: "owner.json could not be inspected", cause: error };
    }

    let handle;
    try {
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
      try {
        handle = await fs.open(ownerPath, fsConstants.O_RDONLY | noFollow);
      } catch (error) {
        if (noFollow === 0 || !isUnsupportedNoFollow(error)) throw error;
        handle = await fs.open(ownerPath, fsConstants.O_RDONLY);
      }
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== ownerBefore.dev ||
        opened.ino !== ownerBefore.ino ||
        opened.size > OWNER_LIMIT
      ) {
        return { kind: "changed" };
      }
      const buffer = Buffer.alloc(OWNER_LIMIT + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > OWNER_LIMIT) {
        return {
          kind: "corrupt",
          reason: `owner.json exceeds ${OWNER_LIMIT} bytes`,
          removable: true
        };
      }
      const raw = buffer.subarray(0, bytesRead);
      const directoryAfter = await fs.lstat(directory);
      if (
        !directoryAfter.isDirectory() ||
        directoryAfter.dev !== directoryBefore.dev ||
        directoryAfter.ino !== directoryBefore.ino
      ) {
        return { kind: "changed" };
      }
      const owner = parseOwner(raw);
      if (owner === undefined) {
        return { kind: "corrupt", reason: "owner.json is malformed", removable: true };
      }
      return {
        kind: "owner",
        record: {
          owner,
          raw,
          identity: "token" in owner ? owner.token : sha256(raw)
        }
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { kind: "changed" };
      return { kind: "corrupt", reason: "owner.json could not be read safely", cause: error };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async waitOrTimeout(started: number, holdingPid?: number): Promise<void> {
    const waited = this.now() - started;
    if (waited >= this.timeoutMs) {
      this.logger.log("warn", "write_lock_timeout", {
        vault: this.vault.id,
        lock_path: LOCK_PATH,
        wait_ms: waited,
        ...(holdingPid === undefined ? {} : { holding_pid: holdingPid })
      });
      throw new ToolFailure(
        "LOCK_TIMEOUT",
        holdingPid === undefined
          ? `The vault write lock at ${LOCK_PATH} remained unavailable for ${waited} ms.`
          : `PID ${holdingPid} held the vault write lock at ${LOCK_PATH} for at least ${waited} ms.`,
        {
          retryable: true,
          details: {
            vault: this.vault.id,
            lock_path: LOCK_PATH,
            waited_ms: waited,
            ...(holdingPid === undefined ? {} : { holding_pid: holdingPid })
          }
        }
      );
    }
    await this.sleep(this.pollMs);
  }

  private async renameForRelease(lease: Lease, retired: string): Promise<void> {
    const started = this.now();
    while (true) {
      try {
        await this.rename(this.canonical, retired);
        return;
      } catch (error) {
        if (!isWindowsTransientRename(error)) throw error;
        const current = await this.inspect(this.canonical);
        if (!matchesToken(current, lease.owner.token)) {
          throw new ReleaseFailure(
            "The canonical write lock changed during a Windows rename retry.",
            false,
            { cause: error }
          );
        }
        const waited = this.now() - started;
        if (waited >= this.timeoutMs) throw error;
        this.logger.log("debug", "write_lock_platform_retry", {
          vault: this.vault.id,
          lock_path: LOCK_PATH,
          code: error.code,
          operation: "release"
        });
        await this.sleep(this.pollMs);
      }
    }
  }

  private async removeKnownDirectory(directory: string, failureEvent: string): Promise<void> {
    try {
      await fs.unlink(path.join(directory, "owner.json")).catch((error: unknown) => {
        if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
      });
      await fs.rmdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      this.logger.log("warn", failureEvent, {
        vault: this.vault.id,
        artifact: path.basename(directory),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private filesystemFailure(message: string, cause?: unknown): ToolFailure {
    const remediation = manualRemediationCommand();
    return new ToolFailure(
      "FILESYSTEM_ERROR",
      `${message} Stop every obsidian-mcp process using vault '${this.vault.id}', open the vault root in a terminal, then run: ${remediation}`,
      {
        details: {
          vault: this.vault.id,
          lock_path: LOCK_PATH,
          remediation
        },
        cause
      }
    );
  }

  private publishFailure(error: unknown): ToolFailure {
    if (isNodeError(error) && (error.code === "EACCES" || error.code === "EPERM")) {
      return new ToolFailure(
        "PERMISSION_DENIED",
        `Permission was denied while publishing the vault write lock at ${LOCK_PATH}.`,
        {
          details: { vault: this.vault.id, lock_path: LOCK_PATH },
          cause: error
        }
      );
    }
    return this.filesystemFailure("The write lock could not be published atomically.", error);
  }

  private releaseToolFailure(
    error: unknown,
    completed: boolean,
    operation: "startup" | "transaction",
    taskError?: unknown
  ): ToolFailure {
    const remediation = manualRemediationCommand();
    const committed = completed && operation === "transaction";
    return new ToolFailure(
      "FILESYSTEM_ERROR",
      committed
        ? `The transaction completed, but its write lock could not be released. Do not retry the transaction blindly. From the vault root, after stopping every obsidian-mcp process, run: ${remediation}`
        : `The write lock could not be released safely. From the vault root, after stopping every obsidian-mcp process, run: ${remediation}`,
      {
        details: {
          vault: this.vault.id,
          lock_path: LOCK_PATH,
          operation_committed: committed,
          remediation
        },
        cause: taskError === undefined ? error : new AggregateError([taskError, error])
      }
    );
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.vault.root) ?? Promise.resolve();
    let releaseQueue: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const tail = previous.then(() => current);
    queues.set(this.vault.root, tail);
    await previous;
    try {
      return await task();
    } finally {
      releaseQueue();
      if (queues.get(this.vault.root) === tail) queues.delete(this.vault.root);
    }
  }
}

function parseOwner(raw: Buffer): ParsedOwner | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0) return undefined;
  if (typeof record.started_at !== "string" || !Number.isFinite(Date.parse(record.started_at))) {
    return undefined;
  }
  if (record.version === undefined) {
    return { pid: Number(record.pid), started_at: record.started_at };
  }
  if (
    record.version !== 1 ||
    typeof record.token !== "string" ||
    !UUID_PATTERN.test(record.token)
  ) {
    return undefined;
  }
  return {
    version: 1,
    token: record.token,
    pid: Number(record.pid),
    started_at: record.started_at
  };
}

function matchesToken(inspection: Inspection, token: string): boolean {
  return (
    inspection.kind === "owner" &&
    "token" in inspection.record.owner &&
    inspection.record.owner.token === token
  );
}

function probePid(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return "dead";
    return "unknown";
  }
}

function isPublishCollision(error: unknown): boolean {
  if (!isNodeError(error)) return false;
  if (
    error.code === "EEXIST" ||
    error.code === "ENOTEMPTY" ||
    error.code === "EISDIR" ||
    error.code === "ENOTDIR"
  ) {
    return true;
  }
  return isWindowsTransientRename(error);
}

function isWindowsTransientRename(error: unknown): error is NodeJS.ErrnoException {
  return (
    process.platform === "win32" &&
    isNodeError(error) &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY")
  );
}

function isBenignRepairRace(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "ENOENT" ||
      error.code === "ENOTEMPTY" ||
      error.code === "EEXIST" ||
      error.code === "EPERM" ||
      error.code === "EBUSY")
  );
}

function isUnsupportedNoFollow(error: unknown): boolean {
  return isNodeError(error) && (error.code === "EINVAL" || error.code === "ENOTSUP");
}

function manualRemediationCommand(): string {
  const destination = `.write.manual-${randomUUID()}`;
  if (process.platform === "win32") {
    return `Rename-Item -LiteralPath '.obsidian-mcp\\locks\\write' -NewName '${destination}'`;
  }
  return `mv -- '.obsidian-mcp/locks/write' '.obsidian-mcp/locks/${destination}'`;
}

async function lstatOptional(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}
