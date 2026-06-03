import { z } from "zod";
import { FileOperationResult } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { ensureDirectory, fileExists } from "../../utils/files.js";
import { createNoteExistsError, handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatFileResult } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

// Input validation schema with descriptions
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault to create the note in"),
  filename: z.string()
    .min(1, "Filename cannot be empty")
    .refine(name => !name.includes('/') && !name.includes('\\'), 
      "Filename cannot contain path separators - use the 'folder' parameter for paths instead. Example: use filename:'note.md', folder:'my/path' instead of filename:'my/path/note.md'")
    .describe("Just the note name without any path separators (e.g. 'my-note.md', NOT 'folder/my-note.md'). Will add .md extension if missing"),
  content: z.string()
    .min(1, "Content cannot be empty")
    .describe("Content of the note in markdown format"),
  folder: z.string()
    .optional()
    .refine(folder => !folder || !path.isAbsolute(folder), 
      "Folder must be a relative path")
    .describe("Optional subfolder path relative to vault root (e.g. 'journal/subfolder'). Use this for the path instead of including it in filename")
}).strict();

async function createNote(
  args: z.infer<typeof schema>,
  vaultPath: string,
  _vaultName: string
): Promise<FileOperationResult> {
  const sanitizedFilename = ensureMarkdownExtension(args.filename);

  const notePath = args.folder
    ? path.join(vaultPath, args.folder, sanitizedFilename)
    : path.join(vaultPath, sanitizedFilename);

  // Validate path is within vault
  await validateVaultPath(vaultPath, notePath);

  try {
    // Create directory structure if needed
    const noteDir = path.dirname(notePath);
    await ensureDirectory(noteDir);

    // Check if file exists first
    if (await fileExists(notePath)) {
      throw createNoteExistsError(notePath);
    }

    // File doesn't exist, proceed with creation
    await fs.writeFile(notePath, args.content, 'utf8');
    
    return {
      success: true,
      message: "Note created successfully",
      path: notePath,
      operation: 'create'
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, 'create note');
  }
}

type CreateNoteArgs = z.infer<typeof schema>;

export function createCreateNoteTool(vaults: Map<string, string>) {
  return createTool<CreateNoteArgs>({
    name: "create-note",
    description: `Create a new note in the specified vault with markdown content.

Examples:
- Root note: { "vault": "vault1", "filename": "note.md" }
- Subfolder note: { "vault": "vault2", "filename": "note.md", "folder": "journal/2024" }
- INCORRECT: { "filename": "journal/2024/note.md" } (don't put path in filename)`,
    schema,
    handler: async (args, vaultPath, vaultName) => {
      const result = await createNote(args, vaultPath, vaultName);
      return createToolResponse(formatFileResult(result));
    }
  }, vaults);
}
