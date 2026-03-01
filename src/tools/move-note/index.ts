import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists, ensureDirectory } from "../../utils/files.js";
import { updateVaultLinks } from "../../utils/links.js";
import { createNoteExistsError, createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createTool } from "../../utils/tool-factory.js";

// Input validation schema with descriptions
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault containing the note"),
  source: z.string()
    .min(1, "Source path cannot be empty")
    .refine(name => !path.isAbsolute(name), 
      "Source must be a relative path within the vault")
    .describe("Source path of the note relative to vault root (e.g., 'folder/note.md')"),
  destination: z.string()
    .min(1, "Destination path cannot be empty")
    .refine(name => !path.isAbsolute(name), 
      "Destination must be a relative path within the vault")
    .describe("Destination path relative to vault root (e.g., 'new-folder/new-name.md')")
}).strict();

type MoveNoteArgs = z.infer<typeof schema>;

async function moveNote(
  args: MoveNoteArgs,
  vaultPath: string
): Promise<string> {
  // Ensure paths are relative to vault
  const fullSourcePath = path.join(vaultPath, args.source);
  const fullDestPath = path.join(vaultPath, args.destination);

  // Validate paths are within vault
  await validateVaultPath(vaultPath, fullSourcePath);
  await validateVaultPath(vaultPath, fullDestPath);

  try {
    // Check if source exists
    if (!await fileExists(fullSourcePath)) {
      throw createNoteNotFoundError(args.source);
    }

    // Check if destination already exists
    if (await fileExists(fullDestPath)) {
      throw createNoteExistsError(args.destination);
    }

    // Ensure destination directory exists
    const destDir = path.dirname(fullDestPath);
    await ensureDirectory(destDir);

    // Move the file
    await fs.rename(fullSourcePath, fullDestPath);
    
    // Update links in the vault
    const updatedFiles = await updateVaultLinks(vaultPath, args.source, args.destination);
    
    return `Successfully moved note from "${args.source}" to "${args.destination}"\n` +
           `Updated links in ${updatedFiles} file${updatedFiles === 1 ? '' : 's'}`;
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, 'move note');
  }
}

export function createMoveNoteTool(vaults: Map<string, string>) {
  return createTool<MoveNoteArgs>({
    name: "move-note",
    description: "Move/rename a note while preserving links",
    schema,
    handler: async (args, vaultPath, vaultName) => {
      const argsWithExt: MoveNoteArgs = {
        vault: args.vault,
        source: ensureMarkdownExtension(args.source),
        destination: ensureMarkdownExtension(args.destination)
      };
      
      const resultMessage = await moveNote(argsWithExt, vaultPath);
      
      return {
        content: [
          {
            type: "text",
            text: resultMessage
          }
        ]
      };
    }
  }, vaults);
}
