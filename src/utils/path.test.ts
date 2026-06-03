import { describe, it, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { normalizePath, validateVaultPath, safeJoinPath } from './path';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

describe('normalizePath', () => {
  describe('Common tests', () => {
    it('should handle relative paths', () => {
      assert.strictEqual(normalizePath('./path/to/file'), path.resolve('./path/to/file'));
      assert.strictEqual(normalizePath('../path/to/file'), path.resolve('../path/to/file'));
    });

    it('should throw error for invalid paths', () => {
      assert.throws(() => normalizePath(''), McpError);
      assert.throws(() => normalizePath(null as any), McpError);
      assert.throws(() => normalizePath(undefined as any), McpError);
      assert.throws(() => normalizePath(123 as any), McpError);
    });
  });

  describe('Windows-specific tests', () => {
    it('should handle Windows drive letters', () => {
      assert.strictEqual(normalizePath('C:\\path\\to\\file'), 'C:/path/to/file');
      assert.strictEqual(normalizePath('D:/path/to/file'), 'D:/path/to/file');
      assert.strictEqual(normalizePath('Z:\\test\\folder'), 'Z:/test/folder');
    });

    it('should allow colons in Windows drive letters', () => {
      assert.strictEqual(normalizePath('C:\\path\\to\\file'), 'C:/path/to/file');
      assert.strictEqual(normalizePath('D:/path/to/file'), 'D:/path/to/file');
      assert.strictEqual(normalizePath('X:\\test\\folder'), 'X:/test/folder');
    });

    it('should reject Windows paths with invalid characters', () => {
      assert.throws(() => normalizePath('C:\\path\\to\\file<'), McpError);
      assert.throws(() => normalizePath('D:/path/to/file>'), McpError);
      assert.throws(() => normalizePath('E:\\test\\folder|'), McpError);
      assert.throws(() => normalizePath('F:/test/folder?'), McpError);
      assert.throws(() => normalizePath('G:\\test\\folder*'), McpError);
    });

    it('should handle UNC paths correctly', () => {
      assert.strictEqual(normalizePath('\\\\server\\share\\path'), '//server/share/path');
      assert.strictEqual(normalizePath('//server/share/path'), '//server/share/path');
      assert.strictEqual(normalizePath('\\\\server\\share\\folder\\file'), '//server/share/folder/file');
    });

    it('should handle network drive paths', () => {
      assert.strictEqual(normalizePath('Z:\\network\\drive'), 'Z:/network/drive');
      assert.strictEqual(normalizePath('Y:/network/drive'), 'Y:/network/drive');
    });

    it('should preserve path separators in UNC paths', () => {
      const result = normalizePath('\\\\server\\share\\path');
      assert.strictEqual(result, '//server/share/path');
      assert.notStrictEqual(result, path.resolve('//server/share/path'));
    });

    it('should preserve drive letters in Windows paths', () => {
      const result = normalizePath('C:\\path\\to\\file');
      assert.strictEqual(result, 'C:/path/to/file');
      assert.notStrictEqual(result, path.resolve('C:/path/to/file'));
    });
  });

  describe('macOS/Unix-specific tests', () => {
    it('should handle absolute paths', () => {
      assert.strictEqual(normalizePath('/path/to/file'), path.resolve('/path/to/file'));
    });

    it('should handle mixed forward/backward slashes', () => {
      assert.strictEqual(normalizePath('path\\to\\file'), 'path/to/file');
    });

    it('should handle paths with colons in filenames', () => {
      assert.strictEqual(normalizePath('/path/to/file:name'), path.resolve('/path/to/file:name'));
    });
  });
});

describe('validateVaultPath', () => {
  let testVault: string;

  beforeAll(async () => {
    // Resolve symlinks so checkPathSafety's prefix check works on macOS (/tmp -> /private/tmp)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-test-'));
    testVault = await fs.realpath(dir);
  });

  afterAll(async () => {
    await fs.rm(testVault, { recursive: true, force: true });
  });

  it('rejects path traversal outside vault', async () => {
    const traversal = path.resolve(testVault, '../../etc/passwd');
    await assert.rejects(() => validateVaultPath(testVault, traversal));
  });

  it('accepts a valid path inside vault', async () => {
    const valid = path.resolve(testVault, 'note.md');
    await assert.doesNotReject(() => validateVaultPath(testVault, valid));
  });
});

describe('safeJoinPath', () => {
  let testVault: string;

  beforeAll(async () => {
    // Resolve symlinks so checkPathSafety's prefix check works on macOS (/tmp -> /private/tmp)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-test-'));
    testVault = await fs.realpath(dir);
  });

  afterAll(async () => {
    await fs.rm(testVault, { recursive: true, force: true });
  });

  it('rejects path traversal via relative segments', async () => {
    await assert.rejects(() => safeJoinPath(testVault, '../../etc'));
  });

  it('returns the joined path for safe segments', async () => {
    const result = await safeJoinPath(testVault, 'note.md');
    assert.strictEqual(result, path.resolve(testVault, 'note.md'));
  });
});
