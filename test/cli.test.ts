import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parseArguments } from "../src/cli.js";
import { Logger } from "../src/utils/logger.js";
import { TransactionManager } from "../src/utils/transaction.js";
import { VaultRegistry, sha256 } from "../src/utils/vault.js";
import { createVault } from "./helpers.js";

const run = promisify(execFile);

test("startup failures never write non-MCP output to stdout", async () => {
  await assert.rejects(
    () => run(process.execPath, ["dist/main.js", "serve", "--vault", "bad=/does/not/exist"]),
    (error: unknown) => {
      const failure = error as Error & { stdout?: string; stderr?: string };
      assert.equal(failure.stdout, "");
      assert.match(failure.stderr ?? "", /error \[VAULT_PATH_NOT_FOUND\]/u);
      assert.match(failure.stderr ?? "", /Problem:/u);
      assert.match(failure.stderr ?? "", /Detected: \/does\/not\/exist/u);
      assert.match(failure.stderr ?? "", /Fix:/u);
      assert.match(failure.stderr ?? "", /Verify:/u);
      assert.match(failure.stderr ?? "", /More help:/u);
      return true;
    }
  );
});

test("doctor reports a fail-closed lock with an exact recoverable rename command", async () => {
  const root = await createVault("obsidian-mcp-cli-lock-");
  const lock = path.join(root, ".obsidian-mcp", "locks", "write");
  await fs.mkdir(lock, { recursive: true });
  await fs.writeFile(path.join(lock, "owner.json"), "{truncated");

  await assert.rejects(
    () =>
      run(process.execPath, [
        "dist/main.js",
        "doctor",
        "--vault",
        `test=${root}`,
        "--log-level",
        "error"
      ]),
    (error: unknown) => {
      const failure = error as Error & { stdout?: string; stderr?: string };
      assert.equal(failure.stdout, "");
      assert.match(failure.stderr ?? "", /error \[FILESYSTEM_ERROR\]/u);
      assert.match(failure.stderr ?? "", /\.obsidian-mcp[\\/]locks[\\/]write/u);
      assert.match(failure.stderr ?? "", /mv --|Rename-Item/u);
      assert.match(failure.stderr ?? "", /\.write\.manual-/u);
      return true;
    }
  );
  assert.equal(await fs.readFile(path.join(lock, "owner.json"), "utf8"), "{truncated");
});

test("CLI usage failures are actionable, typo-aware, and exit with status 2", async () => {
  await assert.rejects(
    () => run(process.execPath, ["dist/main.js", "server"]),
    (error: unknown) => {
      const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
      assert.equal(failure.code, 2);
      assert.equal(failure.stdout, "");
      assert.match(failure.stderr ?? "", /error \[CLI_UNKNOWN_COMMAND\]/u);
      assert.match(failure.stderr ?? "", /Did you mean 'serve'\?/u);
      return true;
    }
  );

  await assert.rejects(
    () => run(process.execPath, ["dist/main.js", "serve", "--valt", "/vault"]),
    (error: unknown) => {
      const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
      assert.equal(failure.code, 2);
      assert.equal(failure.stdout, "");
      assert.match(failure.stderr ?? "", /error \[CLI_UNKNOWN_OPTION\]/u);
      assert.match(failure.stderr ?? "", /Did you mean '--vault'\?/u);
      return true;
    }
  );
});

test("v1 positional paths produce deterministic v2 vault mappings", () => {
  const parsed = parseArguments([
    "/tmp/one/123 Project",
    "/tmp/two/123 Project",
    "/tmp/three/über"
  ]);
  if (typeof parsed === "string") assert.fail("Expected parsed CLI options.");
  assert.deepEqual(
    parsed.vaults.map(({ id }) => id),
    ["vault-123-project", "vault-123-project-2", "ber"]
  );
  assert.equal(parsed.legacy, "serve");
  assert.equal(parsed.warnings[0]?.code, "V1_POSITIONAL_CONFIG_DEPRECATED");
  assert.deepEqual(parsed.canonicalArgs, [
    "serve",
    ...parsed.vaults.flatMap(({ id, root }) => ["--vault", `${id}=${root}`])
  ]);
});

test("mixed positional and v2 vault syntax is rejected with a replacement", () => {
  assert.throws(
    () => parseArguments(["/tmp/vault", "--vault", "notes=/tmp/vault"]),
    (error: unknown) => {
      assert.match(String(error), /Positional vault paths cannot be mixed/u);
      return true;
    }
  );
});

test("CLI and package versions stay synchronized", async () => {
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8")) as {
    version: string;
  };
  const result = await run(process.execPath, ["dist/main.js", "--version"]);
  assert.equal(result.stdout.trim(), packageJson.version);
  assert.equal(result.stderr, "");
});

test("doctor and recovery CLI commands operate on an explicit vault", async () => {
  const root = await createVault("obsidian-mcp-cli-");
  const doctor = await run(process.execPath, [
    "dist/main.js",
    "doctor",
    "--vault",
    `test=${root}`,
    "--log-level",
    "error"
  ]);
  const diagnosis = JSON.parse(doctor.stdout) as {
    ok: boolean;
    vaults: { vault: string }[];
  };
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.vaults[0]?.vault, "test");

  const registry = await VaultRegistry.create([{ id: "test", root }]);
  const target = path.join(registry.get("test").root, "note.md");
  await fs.writeFile(target, "before");
  const manager = new TransactionManager(
    registry.get("test"),
    { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 },
    new Logger("error")
  );
  await manager.initialize();
  const id = await manager.run([
    { kind: "write", path: target, data: Buffer.from("after"), expectedEtag: sha256("before") }
  ]);

  const restored = await run(process.execPath, [
    "dist/main.js",
    "recovery",
    "restore",
    "--vault",
    `test=${root}`,
    "--id",
    id,
    "--log-level",
    "error"
  ]);
  assert.equal((JSON.parse(restored.stdout) as { ok: boolean }).ok, true);
  assert.equal(await fs.readFile(target, "utf8"), "before");
});
