import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ToolFailure } from "../src/utils/errors.js";
import { sha256 } from "../src/utils/hash.js";
import { Logger } from "../src/utils/logger.js";
import { WriteLock, type WriteLockDependencies } from "../src/utils/write-lock.js";
import { VaultRegistry, type ResolvedVault } from "../src/utils/vault.js";
import { createVault } from "./helpers.js";

const ownerTimestamp = "2026-08-21T12:00:00.000Z";
const childFixture = fileURLToPath(new URL("./fixtures/write-lock-child.ts", import.meta.url));
const contenderFixture = fileURLToPath(
  new URL("./fixtures/write-lock-contender.ts", import.meta.url)
);

test("publishes only a complete owner and releases without polling", async () => {
  const { vault, locksRoot } = await setupLock();
  let sleeps = 0;
  const direct = new WriteLock(vault, new Logger("error"), {
    sleep: async () => {
      sleeps += 1;
    }
  });

  await direct.runExclusive(async () => {
    const owner = JSON.parse(
      await fs.readFile(path.join(locksRoot, "write", "owner.json"), "utf8")
    ) as {
      version: number;
      token: string;
      pid: number;
    };
    assert.equal(owner.version, 1);
    assert.match(owner.token, /^[0-9a-f-]{36}$/u);
    assert.equal(owner.pid, process.pid);
  });

  assert.equal(sleeps, 0);
  await assert.rejects(fs.access(path.join(locksRoot, "write")), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(locksRoot), []);
});

test("repairs the legacy empty canonical directory without waiting for timeout", async () => {
  const { lock, locksRoot } = await setupLock();
  await fs.mkdir(path.join(locksRoot, "write"));
  let entered = false;

  await lock.runExclusive(async () => {
    entered = true;
    assert.equal((await fs.readdir(path.join(locksRoot, "write"))).includes("owner.json"), true);
  });

  assert.equal(entered, true);
  await assert.rejects(fs.access(path.join(locksRoot, "write")), { code: "ENOENT" });
});

test("fails closed on a nonempty malformed canonical lock", async () => {
  const { lock, locksRoot } = await setupLock();
  const canonical = path.join(locksRoot, "write");
  await fs.mkdir(canonical);
  await fs.writeFile(path.join(canonical, "owner.json"), "{truncated");

  await assert.rejects(
    lock.runExclusive(async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof ToolFailure);
      assert.equal(error.code, "FILESYSTEM_ERROR");
      assert.equal(error.retryable, false);
      assert.equal(error.details?.lock_path, ".obsidian-mcp/locks/write");
      assert.match(String(error.details?.remediation), /\.write\.manual-/u);
      return true;
    }
  );
  assert.equal(await fs.readFile(path.join(canonical, "owner.json"), "utf8"), "{truncated");
});

test("fails closed on unknown, oversized, and unexpected canonical lock state", async (context) => {
  const cases: Array<{
    name: string;
    prepare: (canonical: string) => Promise<void>;
  }> = [
    {
      name: "unknown owner version",
      prepare: async (canonical) => {
        await fs.mkdir(canonical);
        await fs.writeFile(
          path.join(canonical, "owner.json"),
          JSON.stringify({ version: 2, token: randomUUID(), pid: 1, started_at: ownerTimestamp })
        );
      }
    },
    {
      name: "oversized owner",
      prepare: async (canonical) => {
        await fs.mkdir(canonical);
        await fs.writeFile(path.join(canonical, "owner.json"), Buffer.alloc(16 * 1024 + 1));
      }
    },
    {
      name: "canonical regular file",
      prepare: async (canonical) => fs.writeFile(canonical, "not a directory")
    }
  ];

  if (process.platform !== "win32") {
    cases.push({
      name: "symlinked owner",
      prepare: async (canonical) => {
        await fs.mkdir(canonical);
        const target = path.join(path.dirname(canonical), "outside-owner.json");
        await fs.writeFile(
          target,
          JSON.stringify({ version: 1, token: randomUUID(), pid: 1, started_at: ownerTimestamp })
        );
        await fs.symlink(target, path.join(canonical, "owner.json"));
      }
    });
  }

  for (const fixture of cases) {
    await context.test(fixture.name, async () => {
      const { lock, locksRoot } = await setupLock();
      await fixture.prepare(path.join(locksRoot, "write"));
      await assert.rejects(
        lock.runExclusive(async () => undefined),
        (error: unknown) => {
          assert.ok(error instanceof ToolFailure);
          assert.equal(error.code, "FILESYSTEM_ERROR");
          return true;
        }
      );
      const canonical = path.join(locksRoot, "write");
      await fs.access(canonical);
      if (fixture.name === "canonical regular file") {
        assert.equal(await fs.readFile(canonical, "utf8"), "not a directory");
      }
    });
  }
});

test("times out with holder details when a PID is live or indeterminate", async () => {
  for (const liveness of ["alive", "unknown"] as const) {
    let now = 0;
    const { lock, locksRoot } = await setupLock({
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      probePid: () => liveness,
      timeoutMs: 100,
      pollMs: 25
    });
    await writeLegacyOwner(path.join(locksRoot, "write"), 4242);

    await assert.rejects(
      lock.runExclusive(async () => undefined),
      (error: unknown) => {
        assert.ok(error instanceof ToolFailure);
        assert.equal(error.code, "LOCK_TIMEOUT");
        assert.equal(error.retryable, true);
        assert.equal(error.details?.holding_pid, 4242);
        assert.equal(error.details?.waited_ms, 100);
        return true;
      }
    );
  }
});

test("quarantines a verified-dead legacy owner and retains the CAS tombstone", async () => {
  const { lock, locksRoot } = await setupLock({ probePid: () => "dead" });
  const raw = `${JSON.stringify({ pid: 4242, started_at: ownerTimestamp })}`;
  await writeLegacyOwner(path.join(locksRoot, "write"), 4242, raw);

  await lock.runExclusive(async () => undefined);

  const tombstone = `.write.stale-${sha256(Buffer.from(raw))}`;
  assert.equal(await fs.readFile(path.join(locksRoot, tombstone, "owner.json"), "utf8"), raw);
  assert.deepEqual(await fs.readdir(locksRoot), [tombstone]);
});

test("starts stale-tombstone retention when quarantine occurs, not when the old lock was created", async () => {
  const now = Date.parse(ownerTimestamp);
  const { lock, locksRoot } = await setupLock({
    now: () => now,
    probePid: () => "dead",
    artifactRetentionMs: 1_000
  });
  const raw = JSON.stringify({ pid: 4242, started_at: "2020-01-01T00:00:00.000Z" });
  const canonical = path.join(locksRoot, "write");
  await writeLegacyOwner(canonical, 4242, raw);
  const old = new Date("2020-01-01T00:00:00.000Z");
  await fs.utimes(canonical, old, old);

  await lock.runExclusive(() => lock.pruneArtifacts(), "startup");

  const tombstone = `.write.stale-${sha256(Buffer.from(raw))}`;
  const stats = await fs.stat(path.join(locksRoot, tombstone));
  assert.ok(Math.abs(stats.mtimeMs - now) < 1_000);
});

test("fails closed instead of spinning when the deterministic stale tombstone already exists", async () => {
  const { lock, locksRoot } = await setupLock({ probePid: () => "dead" });
  const raw = JSON.stringify({ pid: 4242, started_at: ownerTimestamp });
  await writeLegacyOwner(path.join(locksRoot, "write"), 4242, raw);
  await writeLegacyOwner(
    path.join(locksRoot, `.write.stale-${sha256(Buffer.from(raw))}`),
    4242,
    raw
  );

  await assert.rejects(
    lock.runExclusive(async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof ToolFailure);
      assert.equal(error.code, "FILESYSTEM_ERROR");
      assert.match(error.message, /tombstone already exists/u);
      return true;
    }
  );
  assert.equal(
    (await fs.readdir(locksRoot)).filter((entry) => entry.startsWith(".write.pending-")).length,
    0
  );
});

test("serializes concurrent calls across WriteLock instances", async () => {
  const { lock, vault } = await setupLock();
  const second = new WriteLock(vault, new Logger("error"));
  const firstEntered = deferred<void>();
  const releaseFirst = deferred<void>();
  let active = 0;
  let maximum = 0;
  const order: string[] = [];

  const first = lock.runExclusive(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    order.push("first-enter");
    firstEntered.resolve();
    await releaseFirst.promise;
    order.push("first-exit");
    active -= 1;
  });
  await firstEntered.promise;
  const next = second.runExclusive(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    order.push("second-enter");
    active -= 1;
  });
  await Promise.resolve();
  assert.deepEqual(order, ["first-enter"]);
  releaseFirst.resolve();
  await Promise.all([first, next]);

  assert.equal(maximum, 1);
  assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
});

test("rejects recursive acquisition immediately", async () => {
  const { lock } = await setupLock();
  await assert.rejects(
    lock.runExclusive(() => lock.runExclusive(async () => undefined)),
    (error: unknown) => {
      assert.ok(error instanceof ToolFailure);
      assert.equal(error.code, "TRANSACTION_FAILED");
      assert.match(error.message, /Recursive/u);
      return true;
    }
  );
});

test("cleans a private candidate when owner initialization fails", async () => {
  const { vault, locksRoot } = await setupLock();
  const lock = new WriteLock(vault, new Logger("error"), {
    lifecycle: (event) => {
      if (event === "owner_opened") throw new Error("injected owner write failure");
    }
  });

  await assert.rejects(
    lock.runExclusive(async () => undefined),
    /injected owner write failure/u
  );
  assert.deepEqual(await fs.readdir(locksRoot), []);
});

test("unpublishes a complete lock when failure occurs after publication", async () => {
  const { vault, locksRoot } = await setupLock();
  const lock = new WriteLock(vault, new Logger("error"), {
    lifecycle: (event) => {
      if (event === "published") throw new Error("injected post-publish failure");
    }
  });

  await assert.rejects(
    lock.runExclusive(async () => undefined),
    /injected post-publish failure/u
  );
  assert.deepEqual(await fs.readdir(locksRoot), []);
});

test("mixed-version empty-directory publication never grants two owners", async () => {
  const beforePublish = deferred<void>();
  const continuePublish = deferred<void>();
  const acquired = deferred<void>();
  const release = deferred<void>();
  let firstPublish = true;
  const { vault, locksRoot } = await setupLock();
  const lock = new WriteLock(vault, new Logger("error"), {
    lifecycle: async (event) => {
      if (event === "before_publish" && firstPublish) {
        firstPublish = false;
        beforePublish.resolve();
        await continuePublish.promise;
      }
    }
  });

  const modern = lock.runExclusive(async () => {
    acquired.resolve();
    await release.promise;
  });
  await beforePublish.promise;
  const canonical = path.join(locksRoot, "write");
  await fs.mkdir(canonical);
  continuePublish.resolve();
  await acquired.promise;

  await assert.rejects(
    fs.writeFile(
      path.join(canonical, "owner.json"),
      JSON.stringify({ pid: 9999, started_at: ownerTimestamp }),
      { flag: "wx" }
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.ok(error.code === "EEXIST" || error.code === "ENOENT");
      return true;
    }
  );
  release.resolve();
  await modern;
});

test("release rechecks the retired token and restores a lock changed during release", async () => {
  const replacement = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    started_at: ownerTimestamp
  };
  let changed = false;
  const { vault, locksRoot } = await setupLock();
  const lock = new WriteLock(vault, new Logger("error"), {
    lifecycle: async (event, lockPath) => {
      if (event === "before_unpublish" && !changed) {
        changed = true;
        await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(replacement));
      }
    }
  });

  await assert.rejects(
    lock.runExclusive(async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof ToolFailure);
      assert.equal(error.code, "FILESYSTEM_ERROR");
      return true;
    }
  );
  const restored = JSON.parse(
    await fs.readFile(path.join(locksRoot, "write", "owner.json"), "utf8")
  ) as { token: string };
  assert.equal(restored.token, replacement.token);
});

test("a failed unpublish is fatal but the poisoned self-owned lease is repaired next time", async () => {
  let failRelease = true;
  const { vault, locksRoot } = await setupLock();
  const rename = async (source: string, destination: string): Promise<void> => {
    if (
      failRelease &&
      path.basename(source) === "write" &&
      path.basename(destination).startsWith(".write.released-")
    ) {
      failRelease = false;
      throw nodeError("EIO");
    }
    await fs.rename(source, destination);
  };
  const lock = new WriteLock(vault, new Logger("error"), { rename });

  await assert.rejects(
    lock.runExclusive(async () => "committed"),
    (error: unknown) => {
      assert.ok(error instanceof ToolFailure);
      assert.equal(error.code, "FILESYSTEM_ERROR");
      assert.equal(error.details?.operation_committed, true);
      return true;
    }
  );
  await fs.access(path.join(locksRoot, "write", "owner.json"));

  let entered = false;
  await lock.runExclusive(async () => {
    entered = true;
  });
  assert.equal(entered, true);
  assert.deepEqual(await fs.readdir(locksRoot), []);
});

test(
  "retries transient Windows release rename failures",
  { skip: process.platform !== "win32" },
  async () => {
    let failures = 2;
    let now = 0;
    const { vault, locksRoot } = await setupLock();
    const rename = async (source: string, destination: string): Promise<void> => {
      if (
        failures > 0 &&
        path.basename(source) === "write" &&
        path.basename(destination).startsWith(".write.released-")
      ) {
        failures -= 1;
        throw nodeError("EPERM");
      }
      await fs.rename(source, destination);
    };
    const lock = new WriteLock(vault, new Logger("error"), {
      rename,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      }
    });

    await lock.runExclusive(async () => undefined);
    assert.equal(failures, 0);
    assert.equal(now, 100);
    assert.deepEqual(await fs.readdir(locksRoot), []);
  }
);

test("reports EXDEV without copying or publishing a partial lock", async () => {
  const { vault, locksRoot } = await setupLock();
  const lock = new WriteLock(vault, new Logger("error"), {
    rename: async () => {
      throw nodeError("EXDEV");
    }
  });

  await assert.rejects(
    lock.runExclusive(async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof ToolFailure);
      assert.equal(error.code, "FILESYSTEM_ERROR");
      assert.match(error.message, /filesystem boundaries/u);
      return true;
    }
  );
  assert.deepEqual(await fs.readdir(locksRoot), []);
});

for (const phase of ["owner_opened", "owner_written", "published", "unpublished"] as const) {
  test(`recovers after a child process exits at ${phase}`, async () => {
    const { lock, vault, locksRoot } = await setupLock();
    const child = spawn(process.execPath, ["--import", "tsx", childFixture, vault.root, phase], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForChildBarrier(child, phase);
    child.kill("SIGKILL");
    await waitForChildExit(child);

    const before = await fs.readdir(locksRoot);
    if (phase === "owner_opened" || phase === "owner_written") {
      assert.equal(before.includes("write"), false);
      assert.equal(
        before.some((entry) => entry.startsWith(".write.pending-")),
        true
      );
      await lock.runExclusive(async () => undefined);
    } else if (phase === "published") {
      const owner = JSON.parse(
        await fs.readFile(path.join(locksRoot, "write", "owner.json"), "utf8")
      ) as { version: number; token: string };
      assert.equal(owner.version, 1);
      assert.match(owner.token, /^[0-9a-f-]{36}$/u);
      await lock.runExclusive(async () => undefined);
      assert.equal(
        (await fs.readdir(locksRoot)).some((entry) => entry.startsWith(".write.stale-")),
        true
      );
    } else {
      assert.equal(before.includes("write"), false);
      assert.equal(
        before.some((entry) => entry.startsWith(".write.released-")),
        true
      );
      await lock.runExclusive(() => lock.pruneArtifacts(), "startup");
      assert.deepEqual(await fs.readdir(locksRoot), []);
    }
  });
}

test("two processes publishing complete candidates never overlap their critical sections", async () => {
  const { vault, locksRoot } = await setupLock();
  const startFile = path.join(locksRoot, "start-contenders");
  const children = Array.from({ length: 2 }, () =>
    spawn(process.execPath, ["--import", "tsx", contenderFixture, vault.root, startFile], {
      stdio: ["ignore", "pipe", "pipe"]
    })
  );
  await Promise.all(children.map((child) => waitForChildBarrier(child, "ready")));
  await fs.writeFile(startFile, "go");
  await Promise.all(children.map(waitForSuccessfulChildExit));

  assert.deepEqual(await fs.readdir(locksRoot), ["start-contenders"]);
});

test("prunes only validated lock artifacts under the held lock", async () => {
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  const { lock, locksRoot } = await setupLock({
    now: () => now,
    probePid: () => "dead",
    artifactRetentionMs: 1_000
  });
  const releasedToken = randomUUID();
  const pendingToken = randomUUID();
  const staleToken = randomUUID();
  await writeVersionedOwner(
    path.join(locksRoot, `.write.released-${releasedToken}`),
    releasedToken
  );
  await writeVersionedOwner(
    path.join(locksRoot, `.write.pending-${pendingToken}`),
    pendingToken,
    5555
  );
  await writeVersionedOwner(path.join(locksRoot, `.write.stale-${staleToken}`), staleToken, 5555);
  const malformed = path.join(locksRoot, `.write.pending-${randomUUID()}`);
  await fs.mkdir(malformed);
  await fs.writeFile(path.join(malformed, "owner.json"), "bad");
  const unexpected = path.join(locksRoot, `.write.pending-${randomUUID()}`);
  await fs.mkdir(unexpected);
  await fs.writeFile(path.join(unexpected, "surprise.txt"), "preserve");
  const old = new Date(now - 2_000);
  await Promise.all([
    fs.utimes(path.join(locksRoot, `.write.stale-${staleToken}`), old, old),
    fs.utimes(malformed, old, old),
    fs.utimes(unexpected, old, old)
  ]);

  await lock.runExclusive(() => lock.pruneArtifacts());

  const remaining = await fs.readdir(locksRoot);
  assert.deepEqual(remaining, [path.basename(unexpected)]);
});

async function setupLock(
  dependencies: WriteLockDependencies = {}
): Promise<{ lock: WriteLock; vault: ResolvedVault; locksRoot: string }> {
  const root = await createVault("obsidian-mcp-lock-test-");
  const registry = await VaultRegistry.create([{ id: "test", root }]);
  const vault = registry.get("test");
  const locksRoot = path.join(vault.stateRoot, "locks");
  await fs.mkdir(locksRoot, { recursive: true, mode: 0o700 });
  return {
    lock: new WriteLock(vault, new Logger("error"), dependencies),
    vault,
    locksRoot
  };
}

async function writeLegacyOwner(directory: string, pid: number, raw?: string): Promise<void> {
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "owner.json"),
    raw ?? JSON.stringify({ pid, started_at: ownerTimestamp })
  );
}

async function writeVersionedOwner(
  directory: string,
  token: string,
  pid = process.pid
): Promise<void> {
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "owner.json"),
    JSON.stringify({ version: 1, token, pid, started_at: ownerTimestamp })
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nodeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

async function waitForChildBarrier(child: ChildProcess, expected: string): Promise<void> {
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expected}: ${stderr}`)),
      5_000
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Child exited before ${expected} (code ${String(code)}, signal ${String(signal)}): ${stderr}`
        )
      );
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (!stdout.split(/\r?\n/u).includes(expected)) return;
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for child exit.")), 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForSuccessfulChildExit(child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  if (child.exitCode !== null) {
    assert.equal(child.exitCode, 0, stderr);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for contender: ${stderr}`)),
      10_000
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Contender exited with ${String(code)}/${String(signal)}: ${stderr}`));
    });
  });
}
