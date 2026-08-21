import { promises as fs } from "node:fs";
import path from "node:path";

import { Logger } from "../../src/utils/logger.js";
import { WriteLock } from "../../src/utils/write-lock.js";
import { VaultRegistry } from "../../src/utils/vault.js";

const root = process.argv[2];
const startFile = process.argv[3];
if (root === undefined || startFile === undefined) throw new Error("Missing fixture arguments.");

const registry = await VaultRegistry.create([{ id: "contender", root }]);
const vault = registry.get("contender");
await fs.mkdir(path.join(vault.stateRoot, "locks"), { recursive: true, mode: 0o700 });

let announced = false;
const lock = new WriteLock(vault, new Logger("error"), {
  lifecycle: async (event) => {
    if (event !== "owner_written" || announced) return;
    announced = true;
    process.stdout.write("ready\n");
    while (true) {
      try {
        await fs.access(startFile);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
});

await lock.runExclusive(async () => {
  const guardPath = path.join(vault.stateRoot, "locks", "exclusive.guard");
  const guard = await fs.open(guardPath, "wx", 0o600);
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await guard.close();
    await fs.unlink(guardPath);
  }
});
