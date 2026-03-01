import { z } from "zod";
import { FileOperationResult } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatFileResult } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

// Input validation schema with descriptions
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault containing the note"),
  filename: z.string()
    .min(1, "Filename cannot be empty")
    .refine(name => !name.includes('/') && !name.includes('\\'), 
      "Filename cannot contain path separators - use the 'folder' parameter for paths instead")
    .describe("Just the note name without any path separators (e.g. 'my-note.md', NOT 'folder/my-note.md')"),
  folder: z.string()
    .optional()
    .refine(folder => !folder || !path.isAbsolute(folder), 
      "Folder must be a relative path")
    .describe("Optional subfolder path relative to vault root")
}).strict();

type ReadNoteInput = z.infer<typeof schema>;

async function readNote(
  vaultPath: string,
  filename: string,
  folder?: string
): Promise<FileOperationResult & { content: string }> {
  const sanitizedFilename = ensureMarkdownExtension(filename);
  const fullPath = folder
    ? path.join(vaultPath, folder, sanitizedFilename)
    : path.join(vaultPath, sanitizedFilename);
  
  // Validate path is within vault
  await validateVaultPath(vaultPath, fullPath);

  try {
    // Check if file exists
    if (!await fileExists(fullPath)) {
      throw createNoteNotFoundError(filename);
    }

    // Read the file content
    const content = await fs.readFile(fullPath, "utf-8");

    return {
      success: true,
      message: "Note read successfully",
      path: fullPath,
      operation: 'edit', // Using 'edit' since we don't have a 'read' operation type
      content: content
    };
  } catch (error: unknown) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, 'read note');
  }
}

export function createReadNoteTool(vaults: Map<string, string>) {
  return createTool<ReadNoteInput>({
    name: "read-note",
    description: `Read the content of an existing note in the vault.

Examples:
- Root note: { "vault": "vault1", "filename": "note.md" }
- Subfolder note: { "vault": "vault1", "filename": "note.md", "folder": "journal/2024" }
- INCORRECT: { "filename": "journal/2024/note.md" } (don't put path in filename)`,
    schema,
    handler: async (args, vaultPath, _vaultName) => {
      const result = await readNote(vaultPath, args.filename, args.folder);
      
      const formattedResult = formatFileResult({
        success: result.success,
        message: result.message,
        path: result.path,
        operation: result.operation
      });
      
      return createToolResponse(
        `${result.content}\n\n${formattedResult}`
      );
    }
  }, vaults);
}
