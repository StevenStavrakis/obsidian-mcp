import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { ToolFailure } from "./errors.js";
import { sha256 } from "./hash.js";
import type { Logger } from "./logger.js";
import { contains, type ResolvedVault } from "./vault.js";
import { WriteLock } from "./write-lock.js";

export type PlannedChange =
  | {
      kind: "write";
      path: string;
      data: Uint8Array;
      expectedEtag?: string;
      requireMissing?: boolean;
    }
  | { kind: "delete"; path: string; expectedEtag?: string; retainSnapshot?: boolean }
  | { kind: "mkdir"; path: string; mode?: number }
  | { kind: "rmdir"; path: string };

interface Snapshot {
  path: string;
  operation: PlannedChange["kind"];
  entryType: "file" | "directory";
  phase: "pending" | "applying" | "applied";
  existed: boolean;
  mode?: number;
  etag?: string;
  plannedEtag?: string;
  snapshot?: string;
  committedEtag?: string;
  recoverable: boolean;
}

interface Manifest {
  id: string;
  state: "preparing" | "committing" | "committed" | "rolled_back";
  createdAt: string;
  completedAt?: string;
  snapshots: Snapshot[];
}

export interface TransactionOptions {
  recoveryDays: number;
  recoveryMaxBytes: number;
}

export class TransactionManager {
  private readonly writeLock: WriteLock;

  constructor(
    private readonly vault: ResolvedVault,
    private readonly options: TransactionOptions,
    private readonly logger: Logger
  ) {
    this.writeLock = new WriteLock(vault, logger);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.join(this.vault.stateRoot, "transactions"), {
      recursive: true,
      mode: 0o700
    });
    await fs.mkdir(path.join(this.vault.stateRoot, "trash"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.vault.stateRoot, "locks"), { recursive: true, mode: 0o700 });
    await this.writeLock.runExclusive(async () => {
      await this.recoverIncomplete();
      await this.prune();
      await this.writeLock.pruneArtifacts();
    }, "startup");
  }

  async run(changes: readonly PlannedChange[]): Promise<string> {
    if (changes.length === 0)
      throw new ToolFailure("INVALID_ARGUMENT", "No changes were requested.");
    return this.writeLock.runExclusive(() => this.execute(changes), "transaction");
  }

  async listRecovery(): Promise<
    {
      id: string;
      state: Manifest["state"];
      created_at: string;
      completed_at?: string;
      files: number;
    }[]
  > {
    const root = path.join(this.vault.stateRoot, "transactions");
    const output: {
      id: string;
      state: Manifest["state"];
      created_at: string;
      completed_at?: string;
      files: number;
    }[] = [];
    for (const dirent of await fs.readdir(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const manifest = await this.readManifest(path.join(root, dirent.name));
      if (manifest === undefined) continue;
      output.push({
        id: manifest.id,
        state: manifest.state,
        created_at: manifest.createdAt,
        ...(manifest.completedAt === undefined ? {} : { completed_at: manifest.completedAt }),
        files: manifest.snapshots.length
      });
    }
    return output.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async restoreRecovery(id: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/u.test(id)) {
      throw new ToolFailure("INVALID_ARGUMENT", "Recovery id is malformed.");
    }
    const root = path.join(this.vault.stateRoot, "transactions", id);
    const manifest = await this.readManifest(root);
    if (manifest === undefined || manifest.state !== "committed") {
      throw new ToolFailure("INVALID_ARGUMENT", "Recovery entry is unavailable or incomplete.");
    }
    const changes: PlannedChange[] = [];
    for (const snapshot of [...manifest.snapshots].reverse()) {
      const target = path.join(this.vault.root, ...snapshot.path.split("/"));
      this.assertManagedPath(target);
      if (snapshot.entryType === "directory") {
        const current = await inspectOptional(target);
        if (snapshot.operation === "mkdir") {
          if (current?.type !== "directory") {
            throw new ToolFailure(
              "REVISION_CONFLICT",
              "A recovered directory changed since the transaction completed."
            );
          }
          changes.push({ kind: "rmdir", path: target });
        } else if (snapshot.operation === "rmdir") {
          if (current !== undefined) {
            throw new ToolFailure(
              "REVISION_CONFLICT",
              "A recovery destination now exists; refusing to replace it."
            );
          }
          changes.push({
            kind: "mkdir",
            path: target,
            ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
          });
        }
        continue;
      }
      const current = await readOptional(target);
      if (snapshot.committedEtag === undefined) {
        if (current !== undefined) {
          throw new ToolFailure(
            "REVISION_CONFLICT",
            "A recovery destination now exists; refusing to overwrite it."
          );
        }
      } else if (current === undefined || sha256(current.data) !== snapshot.committedEtag) {
        throw new ToolFailure(
          "REVISION_CONFLICT",
          "A recovered file has changed since the transaction completed."
        );
      }
      if (snapshot.existed) {
        if (snapshot.snapshot === undefined)
          throw new ToolFailure("TRANSACTION_FAILED", "Recovery snapshot is missing.");
        changes.push({
          kind: "write",
          path: target,
          data: await fs.readFile(path.join(root, snapshot.snapshot)),
          ...(current === undefined
            ? { requireMissing: true }
            : { expectedEtag: sha256(current.data) })
        });
      } else if (current !== undefined) {
        changes.push({ kind: "delete", path: target, expectedEtag: sha256(current.data) });
      }
    }
    if (changes.length === 0) {
      throw new ToolFailure("INVALID_ARGUMENT", "Recovery entry has no restorable changes.");
    }
    return this.run(changes);
  }

  private async execute(changes: readonly PlannedChange[]): Promise<string> {
    const id = randomUUID();
    const transactionRoot = path.join(this.vault.stateRoot, "transactions", id);
    await fs.mkdir(transactionRoot, { recursive: false, mode: 0o700 });
    const snapshots: Snapshot[] = [];
    const seen = new Set<string>();

    try {
      for (const [index, change] of changes.entries()) {
        this.assertManagedPath(change.path);
        await this.assertNoSymlinkComponents(change.path);
        if (seen.has(change.path))
          throw new ToolFailure(
            "INVALID_ARGUMENT",
            "A transaction targets one path more than once."
          );
        seen.add(change.path);
        const current = await inspectOptional(change.path);
        if (change.kind === "write" && current?.type === "directory") {
          throw new ToolFailure("ALREADY_EXISTS", "A directory exists at the file destination.");
        }
        if (change.kind === "write" && change.requireMissing === true && current !== undefined) {
          throw new ToolFailure("ALREADY_EXISTS", "The destination already exists.");
        }
        if (change.kind === "delete" && current?.type !== "file") {
          throw new ToolFailure("NOTE_NOT_FOUND", "The requested note does not exist.");
        }
        if (change.kind === "mkdir" && current !== undefined) {
          throw new ToolFailure("ALREADY_EXISTS", "The directory destination already exists.");
        }
        if (change.kind === "rmdir") {
          if (current?.type !== "directory") {
            throw new ToolFailure("NOTE_NOT_FOUND", "The requested directory does not exist.");
          }
        }
        const expectedEtag =
          change.kind === "write" || change.kind === "delete" ? change.expectedEtag : undefined;
        if (
          expectedEtag !== undefined &&
          (current?.type !== "file" || sha256(current.data) !== expectedEtag)
        ) {
          throw new ToolFailure(
            "REVISION_CONFLICT",
            "The note changed after it was read. Read it again and retry.",
            {
              retryable: true
            }
          );
        }
        const snapshotName = current?.type === "file" ? `${index}.bin` : undefined;
        if (current?.type === "file" && snapshotName !== undefined) {
          await writeDurable(path.join(transactionRoot, snapshotName), current.data, 0o600);
        }
        const base = {
          path: path.relative(this.vault.root, change.path).split(path.sep).join("/"),
          operation: change.kind,
          entryType:
            change.kind === "mkdir" || change.kind === "rmdir"
              ? ("directory" as const)
              : ("file" as const),
          phase: "pending" as const,
          ...(change.kind === "write" ? { plannedEtag: sha256(change.data) } : {}),
          recoverable: change.kind !== "delete" || change.retainSnapshot !== false
        };
        snapshots.push(
          current === undefined
            ? { ...base, existed: false }
            : current.type === "directory"
              ? { ...base, existed: true, mode: current.mode }
              : {
                  ...base,
                  existed: true,
                  mode: current.mode,
                  etag: sha256(current.data),
                  snapshot: snapshotName as string
                }
        );
      }
    } catch (error) {
      await fs.rm(transactionRoot, { recursive: true, force: true });
      throw error;
    }

    const manifest: Manifest = {
      id,
      state: "preparing",
      createdAt: new Date().toISOString(),
      snapshots
    };
    try {
      await this.writeManifest(transactionRoot, manifest);
    } catch (error) {
      await fs.rm(transactionRoot, { recursive: true, force: true });
      throw error;
    }

    try {
      manifest.state = "committing";
      await this.writeManifest(transactionRoot, manifest);
      for (let index = 0; index < changes.length; index += 1) {
        const change = changes[index];
        const snapshot = snapshots[index];
        if (change === undefined || snapshot === undefined) continue;
        await this.assertNoSymlinkComponents(change.path);
        await this.verifyUnchanged(change.path, snapshot);
        snapshot.phase = "applying";
        await this.writeManifest(transactionRoot, manifest);
        if (change.kind === "delete") {
          await fs.unlink(change.path);
          delete snapshot.committedEtag;
        } else if (change.kind === "write") {
          await fs.mkdir(path.dirname(change.path), { recursive: true });
          await this.assertNoSymlinkComponents(change.path);
          await atomicWrite(change.path, change.data, snapshot.existed, snapshot.mode);
          snapshot.committedEtag = sha256(change.data);
        } else if (change.kind === "mkdir") {
          await fs.mkdir(change.path, { mode: change.mode });
        } else {
          await fs.rmdir(change.path);
        }
        snapshot.phase = "applied";
        await this.writeManifest(transactionRoot, manifest);
      }
      manifest.state = "committed";
      manifest.completedAt = new Date().toISOString();
      await this.writeManifest(transactionRoot, manifest);
      let scrubbed = false;
      for (const snapshot of snapshots) {
        if (snapshot.recoverable || snapshot.snapshot === undefined) continue;
        await fs.rm(path.join(transactionRoot, snapshot.snapshot), { force: true });
        snapshot.existed = false;
        delete snapshot.snapshot;
        delete snapshot.etag;
        delete snapshot.mode;
        scrubbed = true;
      }
      if (scrubbed) await this.writeManifest(transactionRoot, manifest);
      this.logger.log("info", "transaction_committed", {
        vault: this.vault.id,
        transaction_id: id
      });
      return id;
    } catch (error) {
      try {
        await this.restoreChanged(transactionRoot, snapshots);
        manifest.state = "rolled_back";
        manifest.completedAt = new Date().toISOString();
        await this.writeManifest(transactionRoot, manifest);
      } catch (rollbackError) {
        this.logger.log("error", "transaction_rollback_failed", {
          vault: this.vault.id,
          transaction_id: id
        });
        throw new ToolFailure(
          "TRANSACTION_FAILED",
          `Transaction ${id} failed and requires recovery.`,
          {
            details: { transaction_id: id },
            cause: rollbackError
          }
        );
      }
      throw error instanceof ToolFailure
        ? error
        : new ToolFailure("TRANSACTION_FAILED", `Transaction ${id} was rolled back.`, {
            retryable: true,
            details: { transaction_id: id },
            cause: error
          });
    }
  }

  private async verifyUnchanged(target: string, snapshot: Snapshot): Promise<void> {
    if (snapshot.entryType === "directory") {
      const current = await inspectOptional(target);
      if (!snapshot.existed && current !== undefined) {
        throw new ToolFailure("REVISION_CONFLICT", "A directory was created concurrently.", {
          retryable: true
        });
      }
      if (
        snapshot.existed &&
        (current?.type !== "directory" || !(await isEmptyDirectory(target)))
      ) {
        throw new ToolFailure("REVISION_CONFLICT", "A directory changed concurrently.", {
          retryable: true
        });
      }
      return;
    }
    const current = await readOptional(target);
    if (!snapshot.existed && current !== undefined) {
      throw new ToolFailure("REVISION_CONFLICT", "A destination was created concurrently.", {
        retryable: true
      });
    }
    if (snapshot.existed && (current === undefined || sha256(current.data) !== snapshot.etag)) {
      throw new ToolFailure(
        "REVISION_CONFLICT",
        "A note changed while the transaction was being prepared.",
        {
          retryable: true
        }
      );
    }
  }

  private async restoreChanged(
    transactionRoot: string,
    snapshots: readonly Snapshot[]
  ): Promise<void> {
    for (const snapshot of [...snapshots].reverse()) {
      const target = path.join(this.vault.root, ...snapshot.path.split("/"));
      if (!(await this.wasApplied(target, snapshot))) continue;
      if (snapshot.entryType === "directory") {
        if (snapshot.existed) await fs.mkdir(target, { mode: snapshot.mode });
        else await fs.rmdir(target);
        snapshot.phase = "pending";
        continue;
      }
      if (!snapshot.existed) {
        await fs.rm(target, { force: true });
        snapshot.phase = "pending";
        continue;
      }
      if (snapshot.snapshot === undefined) throw new Error("Missing transaction snapshot.");
      const bytes = await fs.readFile(path.join(transactionRoot, snapshot.snapshot));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, bytes, await exists(target), snapshot.mode);
      snapshot.phase = "pending";
    }
  }

  private async wasApplied(target: string, snapshot: Snapshot): Promise<boolean> {
    if (snapshot.phase === "pending") return false;
    if (snapshot.entryType === "directory") {
      const current = await inspectOptional(target);
      const originalMatches = snapshot.existed
        ? current?.type === "directory"
        : current === undefined;
      if (originalMatches) return false;
      const appliedMatches =
        snapshot.operation === "mkdir"
          ? current?.type === "directory"
          : snapshot.operation === "rmdir" && current === undefined;
      if (appliedMatches) return true;
      throw new ToolFailure(
        "REVISION_CONFLICT",
        "A transaction directory changed outside the MCP during recovery.",
        { details: { path: snapshot.path } }
      );
    }
    const current = await readOptional(target);
    const currentEtag = current === undefined ? undefined : sha256(current.data);
    const originalMatches = snapshot.existed
      ? currentEtag === snapshot.etag
      : current === undefined;
    if (originalMatches) return false;
    const appliedMatches =
      snapshot.operation === "delete"
        ? current === undefined
        : currentEtag === snapshot.plannedEtag;
    if (appliedMatches) return true;
    throw new ToolFailure(
      "REVISION_CONFLICT",
      "A transaction path changed outside the MCP during recovery; refusing to overwrite it.",
      { details: { path: snapshot.path } }
    );
  }

  private async recoverIncomplete(): Promise<void> {
    const root = path.join(this.vault.stateRoot, "transactions");
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const transactionRoot = path.join(root, entry.name);
      const manifest = await this.readManifest(transactionRoot);
      if (
        manifest === undefined ||
        (manifest.state !== "preparing" && manifest.state !== "committing")
      )
        continue;
      await this.restoreChanged(transactionRoot, manifest.snapshots);
      manifest.state = "rolled_back";
      manifest.completedAt = new Date().toISOString();
      await this.writeManifest(transactionRoot, manifest);
      this.logger.log("warn", "transaction_recovered", {
        vault: this.vault.id,
        transaction_id: manifest.id
      });
    }
  }

  private async prune(): Promise<void> {
    const root = path.join(this.vault.stateRoot, "transactions");
    const entries: { path: string; completedAt: number; size: number }[] = [];
    for (const dirent of await fs.readdir(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const transactionRoot = path.join(root, dirent.name);
      const manifest = await this.readManifest(transactionRoot);
      if (manifest?.completedAt === undefined) continue;
      entries.push({
        path: transactionRoot,
        completedAt: Date.parse(manifest.completedAt),
        size: await directorySize(transactionRoot)
      });
    }
    entries.sort((a, b) => a.completedAt - b.completedAt);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const cutoff = Date.now() - this.options.recoveryDays * 86_400_000;
    for (const entry of entries) {
      if (entry.completedAt < cutoff || total > this.options.recoveryMaxBytes) {
        await fs.rm(entry.path, { recursive: true });
        total -= entry.size;
      }
    }
  }

  private assertManagedPath(target: string): void {
    const trashRoot = path.join(this.vault.stateRoot, "trash");
    if (
      !contains(this.vault.root, target) ||
      (contains(this.vault.stateRoot, target) && !contains(trashRoot, target))
    ) {
      throw new ToolFailure(
        "PATH_REJECTED",
        "Transaction path is outside the managed vault content."
      );
    }
  }

  private async assertNoSymlinkComponents(target: string): Promise<void> {
    const relative = path.relative(this.vault.root, target);
    let current = this.vault.root;
    for (const component of relative.split(path.sep)) {
      if (component === "") continue;
      current = path.join(current, component);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) {
          throw new ToolFailure(
            "SYMLINK_NOT_ALLOWED",
            "A path component became a symlink before the transaction committed."
          );
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
    }
  }

  private async writeManifest(root: string, manifest: Manifest): Promise<void> {
    await atomicWrite(
      path.join(root, "manifest.json"),
      Buffer.from(JSON.stringify(manifest, null, 2)),
      true,
      0o600
    );
  }

  private async readManifest(root: string): Promise<Manifest | undefined> {
    try {
      return JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")) as Manifest;
    } catch {
      return undefined;
    }
  }
}

async function atomicWrite(
  target: string,
  data: Uint8Array,
  replace: boolean,
  mode = 0o600
): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`
  );
  await writeDurable(temporary, data, mode);
  try {
    if (replace) {
      await fs.rename(temporary, target);
    } else {
      await fs.link(temporary, target);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    await syncDirectory(path.dirname(target));
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      ["EINVAL", "EISDIR", "EPERM", "EBADF"].includes(String(error.code))
    )) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function writeDurable(target: string, data: Uint8Array, mode: number): Promise<void> {
  const handle = await fs.open(
    target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
    mode
  );
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOptional(target: string): Promise<{ data: Buffer; mode: number } | undefined> {
  try {
    const stat = await fs.stat(target);
    return { data: await fs.readFile(target), mode: stat.mode };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

type InspectedEntry =
  { type: "file"; data: Buffer; mode: number } | { type: "directory"; mode: number };

async function inspectOptional(target: string): Promise<InspectedEntry | undefined> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) return { type: "directory", mode: stat.mode };
    if (stat.isFile()) return { type: "file", data: await fs.readFile(target), mode: stat.mode };
    throw new ToolFailure("PATH_REJECTED", "Only regular files and directories are supported.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function isEmptyDirectory(target: string): Promise<boolean> {
  return (await fs.readdir(target)).length === 0;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(root: string): Promise<number> {
  let size = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    size += entry.isDirectory() ? await directorySize(target) : (await fs.stat(target)).size;
  }
  return size;
}
