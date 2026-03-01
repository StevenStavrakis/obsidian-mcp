import { promises as fs, Dirent } from "fs";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { normalizePath, safeJoinPath } from "./path.js";

/**
 * Recursively gets all markdown files in a directory
 */
export async function getAllMarkdownFiles(vaultPath: string, dir = vaultPath): Promise<string[]> {
  // Normalize paths upfront
  const normalizedVaultPath = normalizePath(vaultPath);
  const normalizedDir = normalizePath(dir);

  // Verify directory is within vault
  if (!normalizedDir.startsWith(normalizedVaultPath)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Search directory must be within vault: ${dir}`
    );
  }

  try {
    const files: string[] = [];
    let entries: Dirent[];
    
    try {
      entries = await fs.readdir(normalizedDir, { withFileTypes: true });
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Directory not found: ${dir}`
        );
      }
      throw error;
    }

    for (const entry of entries) {
      try {
        // Use safeJoinPath to ensure path safety
        const fullPath = await safeJoinPath(normalizedDir, entry.name);
        
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".")) {
            const subDirFiles = await getAllMarkdownFiles(normalizedVaultPath, fullPath);
            files.push(...subDirFiles);
          }
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(fullPath);
        }
      } catch (error) {
        // Log but don't throw - we want to continue processing other files
        if (error instanceof McpError) {
          console.error(`Skipping ${entry.name}:`, error.message);
        } else {
          console.error(`Error processing ${entry.name}:`, error);
        }
      }
    }

    return files;
  } catch (error) {
    if (error instanceof McpError) throw error;
    
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to read directory ${dir}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Ensures a directory exists, creating it if necessary
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  const normalizedPath = normalizePath(dirPath);
  
  try {
    await fs.mkdir(normalizedPath, { recursive: true });
  } catch (error: any) {
    if (error.code !== 'EEXIST') {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create directory ${dirPath}: ${error.message}`
      );
    }
  }
}

/**
 * Checks if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  const normalizedPath = normalizePath(filePath);
  
  try {
    await fs.access(normalizedPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely reads a file's contents
 * Returns undefined if file doesn't exist
 */
export async function safeReadFile(filePath: string): Promise<string | undefined> {
  const normalizedPath = normalizePath(filePath);
  
  try {
    return await fs.readFile(normalizedPath, 'utf-8');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to read file ${filePath}: ${error.message}`
    );
  }
}
