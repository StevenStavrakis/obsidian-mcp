import { promises as fs } from "node:fs";
import path from "node:path";

import { Logger } from "../../src/utils/logger.js";
import { WriteLock, type WriteLockLifecycleEvent } from "../../src/utils/write-lock.js";
import { VaultRegistry } from "../../src/utils/vault.js";

const root = process.argv[2];
const pauseAt = process.argv[3] as WriteLockLifecycleEvent | undefined;
if (root === undefined || pauseAt === undefined) throw new Error("Missing fixture arguments.");

const registry = await VaultRegistry.create([{ id: "child", root }]);
const vault = registry.get("child");
await fs.mkdir(path.join(vault.stateRoot, "locks"), { recursive: true, mode: 0o700 });

const lock = new WriteLock(vault, new Logger("error"), {
  lifecycle: async (event) => {
    if (event !== pauseAt) return;
    process.stdout.write(`${event}\n`);
    await new Promise<void>(() => undefined);
  }
});

await lock.runExclusive(async () => undefined);
