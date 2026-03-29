import path from "path";
import fs from "fs/promises";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import os from "os";
import { exec as execCallback } from "child_process";
import { promisify } from "util";

// Promisify exec for cleaner async/await usage
const exec = promisify(execCallback);

/**
 * Checks if a path contains any problematic characters or patterns
 * @param vaultPath - The path to validate
 * @returns Error message if invalid, null if valid
 */
export function checkPathCharacters(vaultPath: string): string | null {
  // Platform-specific path length limits
  const maxPathLength = process.platform === 'win32' ? 260 : 4096;
  if (vaultPath.length > maxPathLength) {
    return `Path exceeds maximum length (${maxPathLength} characters)`;
  }

  // Check component length (individual parts between separators)
  const components = vaultPath.split(/[\/\\]/);
  const maxComponentLength = process.platform === 'win32' ? 255 : 255;
  const longComponent = components.find(c => c.length > maxComponentLength);
  if (longComponent) {
    return `Directory/file name too long: "${longComponent.slice(0, 50)}..."`;
  }

  // Check for root-only paths
  if (process.platform === 'win32') {
    if (/^[A-Za-z]:\\?$/.test(vaultPath)) {
      return 'Cannot use drive root directory';
    }
  } else {
    if (vaultPath === '/') {
      return 'Cannot use filesystem root directory';
    }
  }

  // Check for relative path components
  if (components.includes('..') || components.includes('.')) {
    return 'Path cannot contain relative components (. or ..)';
  }

  // Check for non-printable characters
  if (/[\x00-\x1F\x7F]/.test(vaultPath)) {
    return 'Contains non-printable characters';
  }

  // Platform-specific checks
  if (process.platform === 'win32') {
    // Windows-specific checks
    const winReservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
    const pathParts = vaultPath.split(/[\/\\]/);
    if (pathParts.some(part => winReservedNames.test(part))) {
      return 'Contains Windows reserved names (CON, PRN, etc.)';
    }

    // Windows invalid characters (allowing : for drive letters)
    // First check if this is a Windows path with a drive letter
    if (/^[A-Za-z]:[\/\\]/.test(vaultPath)) {
      // Skip the drive letter part and check the rest of the path
      const pathWithoutDrive = vaultPath.slice(2);
      const components = pathWithoutDrive.split(/[\/\\]/);
      for (const part of components) {
        if (/[<>:"|?*]/.test(part)) {
          return 'Contains characters not allowed on Windows (<>:"|?*)';
        }
      }
    } else {
      // No drive letter, check all components normally
      const components = vaultPath.split(/[\/\\]/);
      for (const part of components) {
        if (/[<>:"|?*]/.test(part)) {
          return 'Contains characters not allowed on Windows (<>:"|?*)';
        }
      }
    }

    // Windows device paths
    if (/^\\\\.\\/.test(vaultPath)) {
      return 'Device paths are not allowed';
    }
  } else {
    // Unix-specific checks
    const unixInvalidChars = /[\x00]/;  // Only check for null character
    const pathComponents = vaultPath.split('/');
    for (const component of pathComponents) {
      if (unixInvalidChars.test(component)) {
        return 'Contains invalid characters for Unix paths';
      }
    }
  }

  // Check for Unicode replacement character
  if (vaultPath.includes('\uFFFD')) {
    return 'Contains invalid Unicode characters';
  }

  // Check for leading/trailing whitespace
  if (vaultPath !== vaultPath.trim()) {
    return 'Contains leading or trailing whitespace';
  }

  // Check for consecutive separators
  if (/[\/\\]{2,}/.test(vaultPath)) {
    return 'Contains consecutive path separators';
  }

  return null;
}

/**
 * Checks if a path is on a local filesystem
 * @param vaultPath - The path to check
 * @returns Error message if invalid, null if valid
 */
export async function checkLocalPath(vaultPath: string): Promise<string | null> {
  try {
    // Get real path (resolves symlinks)
    const realPath = await fs.realpath(vaultPath);
    
    // Check if path changed significantly after resolving symlinks
    if (path.dirname(realPath) !== path.dirname(vaultPath)) {
      return 'Path contains symlinks that point outside the parent directory';
    }

    // Check for network paths
    if (process.platform === 'win32') {
      // Windows UNC paths and mapped drives
      if (realPath.startsWith('\\\\') || /^[a-zA-Z]:\\$/.test(realPath.slice(0, 3))) {
        // Check Windows drive type
        const drive = realPath[0].toUpperCase();
        
        // Helper functions for drive type checking
        async function checkWithWmic() {
          const cmd = `wmic logicaldisk where "DeviceID='${drive}:'" get DriveType /value`;
          return await exec(cmd, { timeout: 5000 });
        }

        async function checkWithPowershell() {
          const cmd = `powershell -Command "(Get-WmiObject -Class Win32_LogicalDisk | Where-Object { $_.DeviceID -eq '${drive}:' }).DriveType"`;
          const { stdout, stderr } = await exec(cmd, { timeout: 5000 });
          return { stdout: `DriveType=${stdout.trim()}`, stderr };
        }
        
        try {
          let result: { stdout: string; stderr: string };
          try {
            result = await checkWithWmic();
          } catch (wmicError) {
            // Fallback to PowerShell if WMIC fails
            result = await checkWithPowershell();
          }

          const { stdout, stderr } = result;

          if (stderr) {
            console.error(`Warning: Drive type check produced errors:`, stderr);
          }

          // DriveType: 2 = Removable, 3 = Local, 4 = Network, 5 = CD-ROM, 6 = RAM disk
          const match = stdout.match(/DriveType=(\d+)/);
          const driveType = match ? match[1] : '0';
          
          // Consider removable drives and unknown types as potentially network-based
          if (driveType === '0' || driveType === '2' || driveType === '4') {
            return 'Network, removable, or unknown drive type is not supported';
          }
        } catch (error: unknown) {
          if ((error as Error & { code?: string }).code === 'ETIMEDOUT') {
            return 'Network, removable, or unknown drive type is not supported';
          }
          console.error(`Error checking drive type:`, error);
          // Fail safe: treat any errors as potential network drives
          return 'Unable to verify if drive is local';
        }
      }
    } else {
      // Unix network mounts (common mount points)
      const networkPaths = ['/net/', '/mnt/', '/media/', '/Volumes/'];
      if (networkPaths.some(prefix => realPath.startsWith(prefix))) {
        // Check if it's a network mount using df
        // Check Unix mount type
        const cmd = `df -P "${realPath}" | tail -n 1`;
        try {
          const { stdout, stderr } = await exec(cmd, { timeout: 5000 })
            .catch((error: Error & { code?: string }) => {
              if (error.code === 'ETIMEDOUT') {
                // Timeout often indicates a network mount
                return { stdout: 'network', stderr: '' };
              }
              throw error;
            });

          if (stderr) {
            console.error(`Warning: Mount type check produced errors:`, stderr);
          }

          // Check for common network filesystem indicators
          const isNetwork = stdout.match(/^(nfs|cifs|smb|afp|ftp|ssh|davfs)/i) ||
                          stdout.includes(':') ||
                          stdout.includes('//') ||
                          stdout.includes('type fuse.') ||
                          stdout.includes('network');

          if (isNetwork) {
            return 'Network or remote filesystem is not supported';
          }
        } catch (error: unknown) {
          console.error(`Error checking mount type:`, error);
          // Fail safe: treat any errors as potential network mounts
          return 'Unable to verify if filesystem is local';
        }
      }
    }

    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      return 'Contains circular symlinks';
    }
    return null; // Other errors will be caught by the main validation
  }
}

/**
 * Checks if a path contains any suspicious patterns
 * @param vaultPath - The path to check
 * @returns Error message if suspicious, null if valid
 */
export async function checkSuspiciousPath(vaultPath: string): Promise<string | null> {
  // Check for hidden directories (except .obsidian)
  if (vaultPath.split(path.sep).some(part => 
    part.startsWith('.') && part !== '.obsidian')) {
    return 'Contains hidden directories';
  }

  // Check for system directories
  const systemDirs = [
    '/bin', '/sbin', '/usr/bin', '/usr/sbin',
    '/etc', '/var', '/tmp', '/dev', '/sys',
    'C:\\Windows', 'C:\\Program Files', 'C:\\System32',
    'C:\\Users\\All Users', 'C:\\ProgramData'
  ];
  if (systemDirs.some(dir => vaultPath.toLowerCase().startsWith(dir.toLowerCase()))) {
    return 'Points to a system directory';
  }

  // Check for home directory root (too broad access)
  if (vaultPath === os.homedir()) {
    return 'Points to home directory root';
  }

  // Check for path length
  if (vaultPath.length > 255) {
    return 'Path is too long (maximum 255 characters)';
  }

  // Check for problematic characters
  const charIssue = checkPathCharacters(vaultPath);
  if (charIssue) {
    return charIssue;
  }

  return null;
}

/**
 * Normalizes and resolves a path consistently
 * @param inputPath - The path to normalize
 * @returns The normalized and resolved absolute path
 * @throws {McpError} If the input path is empty or invalid
 */
export function normalizePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== "string") {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Invalid path: ${inputPath}`
    );
  }

  try {
    // Handle Windows paths
    let normalized = inputPath;

    // Only validate filename portion for invalid Windows characters, allowing : for drive letters
    const filename = normalized.split(/[\\/]/).pop() || '';
    if (/[<>"|?*]/.test(filename) || (/:/.test(filename) && !/^[A-Za-z]:$/.test(filename))) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Filename contains invalid characters: ${filename}`
      );
    }
    
    // Preserve UNC paths
    if (normalized.startsWith('\\\\')) {
      // Convert to forward slashes but preserve exactly two leading slashes
      normalized = '//' + normalized.slice(2).replace(/\\/g, '/');
      return normalized;
    }

    // Handle Windows drive letters
    if (/^[a-zA-Z]:[\\/]/.test(normalized)) {
      // Normalize path while preserving drive letter
      normalized = path.normalize(normalized);
      // Convert to forward slashes for consistency
      normalized = normalized.replace(/\\/g, '/');
      return normalized;
    }

    // Only restrict critical system directories
    const restrictedDirs = [
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData'
    ];
    if (restrictedDirs.some(dir => normalized.toLowerCase().startsWith(dir.toLowerCase()))) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Path points to restricted system directory: ${normalized}`
      );
    }

    // Handle relative paths
    if (normalized.startsWith('./') || normalized.startsWith('../')) {
      normalized = path.normalize(normalized);
      return path.resolve(normalized);
    }

    // Default normalization for other paths
    normalized = normalized.replace(/\\/g, '/');
    if (normalized.startsWith('./') || normalized.startsWith('../')) {
      return path.resolve(normalized);
    }
    return normalized;
  } catch (error) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Failed to normalize path: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Checks if a target path is safely contained within a base path
 * @param basePath - The base directory path
 * @param targetPath - The target path to check
 * @returns True if target is within base path, false otherwise
 */
export async function checkPathSafety(basePath: string, targetPath: string): Promise<boolean> {
  const resolvedPath = normalizePath(targetPath);
  const resolvedBasePath = normalizePath(basePath);

  try {
    // Check real path for symlinks
    const realPath = await fs.realpath(resolvedPath);
    const normalizedReal = normalizePath(realPath);
    
    // Check if real path is within base path
    if (!normalizedReal.startsWith(resolvedBasePath)) {
      return false;
    }

    // Check if original path is within base path
    return resolvedPath.startsWith(resolvedBasePath);
  } catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = path.dirname(resolvedPath);
    try {
      const realParentPath = await fs.realpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      return normalizedParent.startsWith(resolvedBasePath);
    } catch {
      return false;
    }
  }
}

/**
 * Ensures a path has .md extension and is valid
 * @param filePath - The file path to check
 * @returns The path with .md extension
 * @throws {McpError} If the path is invalid
 */
export function ensureMarkdownExtension(filePath: string): string {
  const normalized = normalizePath(filePath);
  return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
}

/**
 * Validates that a path is within the vault directory
 * @param vaultPath - The vault directory path
 * @param targetPath - The target path to validate
 * @throws {McpError} If path is outside vault or invalid
 */
export async function validateVaultPath(vaultPath: string, targetPath: string): Promise<void> {
  if (!(await checkPathSafety(vaultPath, targetPath))) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Path must be within the vault directory. Path: ${targetPath}, Vault: ${vaultPath}`
    );
  }
}

/**
 * Safely joins paths and ensures result is within vault
 * @param vaultPath - The vault directory path
 * @param segments - Path segments to join
 * @returns The joined and validated path
 * @throws {McpError} If resulting path would be outside vault
 */
export async function safeJoinPath(vaultPath: string, ...segments: string[]): Promise<string> {
  const joined = path.join(vaultPath, ...segments);
  const resolved = normalizePath(joined);

  await validateVaultPath(vaultPath, resolved);

  return resolved;
}

/**
 * Sanitizes a vault name to be filesystem-safe
 * @param name - The raw vault name
 * @returns The sanitized vault name
 */
export function sanitizeVaultName(name: string): string {
  return name
    .toLowerCase()
    // Replace spaces and special characters with hyphens
    .replace(/[^a-z0-9]+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Ensure name isn't empty
    || 'unnamed-vault';
}

/**
 * Checks if one path is a parent of another
 * @param parent - The potential parent path
 * @param child - The potential child path
 * @returns True if parent contains child, false otherwise
 */
export function isParentPath(parent: string, child: string): boolean {
  const relativePath = path.relative(parent, child);
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

/**
 * Checks if paths overlap or are duplicates
 * @param paths - Array of paths to check
 * @throws {McpError} If paths overlap or are duplicates
 */
export function checkPathOverlap(paths: string[]): void {
  // First normalize all paths to handle . and .. and symlinks
  const normalizedPaths = paths.map(p => {
    // Remove trailing slashes and normalize separators
    return path.normalize(p).replace(/[\/\\]+$/, '');
  });

  // Check for exact duplicates using normalized paths
  const uniquePaths = new Set<string>();
  normalizedPaths.forEach((normalizedPath, index) => {
    if (uniquePaths.has(normalizedPath)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Duplicate vault path provided:\n` +
        `  Original paths:\n` +
        `    1: ${paths[index]}\n` +
        `    2: ${paths[normalizedPaths.indexOf(normalizedPath)]}\n` +
        `  Both resolve to: ${normalizedPath}`
      );
    }
    uniquePaths.add(normalizedPath);
  });

  // Then check for overlapping paths using normalized paths
  for (let i = 0; i < normalizedPaths.length; i++) {
    for (let j = i + 1; j < normalizedPaths.length; j++) {
      if (isParentPath(normalizedPaths[i], normalizedPaths[j]) || 
          isParentPath(normalizedPaths[j], normalizedPaths[i])) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Vault paths cannot overlap:\n` +
          `  Path 1: ${paths[i]}\n` +
          `  Path 2: ${paths[j]}\n` +
          `  (One vault directory cannot be inside another)\n` +
          `  Normalized paths:\n` +
          `    1: ${normalizedPaths[i]}\n` +
          `    2: ${normalizedPaths[j]}`
        );
      }
    }
  }
}
