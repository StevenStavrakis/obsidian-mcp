import { z } from "zod";
import { FileOperationResult } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatFileResult } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

// Input validation schema with descriptions
// Schema for delete operation
const deleteSchema = z.object({
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
    .describe("Optional subfolder path relative to vault root"),
  operation: z.literal('delete')
    .describe("Delete operation"),
  content: z.undefined()
    .describe("Must not provide content for delete operation")
}).strict();

// Schema for non-delete operations
const editSchema = z.object({
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
    .describe("Optional subfolder path relative to vault root"),
  operation: z.enum(['append', 'prepend', 'replace'])
    .describe("Type of edit operation - must be one of: 'append', 'prepend', 'replace'")
    .refine(
      (op) => ['append', 'prepend', 'replace'].includes(op),
      {
        message: "Invalid operation. Must be one of: 'append', 'prepend', 'replace'",
        path: ['operation']
      }
    ),
  content: z.string()
    .min(1, "Content cannot be empty for non-delete operations")
    .describe("New content to add/prepend/replace")
}).strict();

// Combined schema using discriminated union
const schema = z.discriminatedUnion('operation', [deleteSchema, editSchema]);

// Types
type EditOperation = 'append' | 'prepend' | 'replace' | 'delete';

async function editNote(
  vaultPath: string, 
  filename: string,
  operation: EditOperation,
  content?: string,
  folder?: string
): Promise<FileOperationResult> {
  const sanitizedFilename = ensureMarkdownExtension(filename);
  const fullPath = folder
    ? path.join(vaultPath, folder, sanitizedFilename)
    : path.join(vaultPath, sanitizedFilename);
  
  // Validate path is within vault
  await validateVaultPath(vaultPath, fullPath);

  // Create unique backup filename
  const timestamp = Date.now();
  const backupPath = `${fullPath}.${timestamp}.backup`;

  try {
    // For non-delete operations, create backup first
    if (operation !== 'delete' && await fileExists(fullPath)) {
      await fs.copyFile(fullPath, backupPath);
    }

    switch (operation) {
      case 'delete': {
        if (!await fileExists(fullPath)) {
          throw createNoteNotFoundError(filename);
        }
        // For delete, create backup before deleting
        await fs.copyFile(fullPath, backupPath);
        await fs.unlink(fullPath);
        
        // On successful delete, remove backup after a short delay
        // This gives a small window for potential recovery if needed
        setTimeout(async () => {
          try {
            await fs.unlink(backupPath);
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('Failed to cleanup backup file:', errorMessage);
          }
        }, 5000);

        return {
          success: true,
          message: "Note deleted successfully",
          path: fullPath,
          operation: 'delete'
        };
      }
      
      case 'append':
      case 'prepend':
      case 'replace': {
        // Check if file exists for non-delete operations
        if (!await fileExists(fullPath)) {
          throw createNoteNotFoundError(filename);
        }

        try {
          // Read existing content
          const existingContent = await fs.readFile(fullPath, "utf-8");
          
          // Prepare new content based on operation
          let newContent: string;
          if (operation === 'append') {
            newContent = existingContent.trim() + (existingContent.trim() ? '\n\n' : '') + content;
          } else if (operation === 'prepend') {
            newContent = content + (existingContent.trim() ? '\n\n' : '') + existingContent.trim();
          } else {
            // replace
            newContent = content as string;
          }

          // Write the new content
          await fs.writeFile(fullPath, newContent);
          
          // Clean up backup on success
          await fs.unlink(backupPath);

          return {
            success: true,
            message: `Note ${operation}ed successfully`,
            path: fullPath,
            operation: 'edit'
          };
        } catch (error: unknown) {
          // On error, attempt to restore from backup
          if (await fileExists(backupPath)) {
            try {
              await fs.copyFile(backupPath, fullPath);
              await fs.unlink(backupPath);
            } catch (rollbackError: unknown) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              const rollbackErrorMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
              
              throw new McpError(
                ErrorCode.InternalError,
                `Failed to rollback changes. Original error: ${errorMessage}. Rollback error: ${rollbackErrorMessage}. Backup file preserved at ${backupPath}`
              );
            }
          }
          throw error;
        }
      }
      
      default: {
        const _exhaustiveCheck: never = operation;
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid operation: ${operation}`
        );
      }
    }
  } catch (error: unknown) {
    // If we have a backup and haven't handled the error yet, try to restore
    if (await fileExists(backupPath)) {
      try {
        await fs.copyFile(backupPath, fullPath);
        await fs.unlink(backupPath);
      } catch (rollbackError: unknown) {
        const rollbackErrorMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        console.error('Failed to cleanup/restore backup during error handling:', rollbackErrorMessage);
      }
    }

    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, `${operation} note`);
  }
}

type EditNoteArgs = z.infer<typeof schema>;

export function createEditNoteTool(vaults: Map<string, string>) {
  return createTool<EditNoteArgs>({
    name: "edit-note",
    description: `Edit an existing note in the specified vault.

    There is a limited and discrete list of supported operations:
    - append: Appends content to the end of the note
    - prepend: Prepends content to the beginning of the note
    - replace: Replaces the entire content of the note

Examples:
- Root note: { "vault": "vault1", "filename": "note.md", "operation": "append", "content": "new content" }
- Subfolder note: { "vault": "vault2", "filename": "note.md", "folder": "journal/2024", "operation": "append", "content": "new content" }
- INCORRECT: { "filename": "journal/2024/note.md" } (don't put path in filename)`,
    schema,
    handler: async (args, vaultPath, _vaultName) => {
      const result = await editNote(
        vaultPath, 
        args.filename, 
        args.operation, 
        'content' in args ? args.content : undefined, 
        args.folder
      );
      return createToolResponse(formatFileResult(result));
    }
  }, vaults);
}
