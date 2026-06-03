import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { validateVaultPath } from "../../utils/path.js";
import { fileExists, safeReadFile } from "../../utils/files.js";
import {
  validateTag,
  parseNote,
  stringifyNote,
  addTagsToFrontmatter,
  removeTagsFromFrontmatter,
  removeInlineTags,
  normalizeTag
} from "../../utils/tags.js";
import { createTool } from "../../utils/tool-factory.js";

// Input validation schema
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault containing the notes"),
  files: z.array(z.string())
    .min(1, "At least one file must be specified")
    .refine(
      files => files.every(f => f.endsWith('.md')),
      "All files must have .md extension"
    ),
  operation: z.enum(['add', 'remove'])
    .describe("Whether to add or remove the specified tags"),
  tags: z.array(z.string())
    .min(1, "At least one tag must be specified")
    .refine(
      tags => tags.every(validateTag),
      "Invalid tag format. Tags must contain only letters, numbers, and forward slashes for hierarchy."
    ),
  options: z.object({
    location: z.enum(['frontmatter', 'content', 'both'])
      .default('frontmatter')
      .describe("Where to add/remove tags"),
    normalize: z.boolean()
      .default(true)
      .describe("Whether to normalize tag format"),
    position: z.enum(['start', 'end'])
      .default('end')
      .describe("Where to add inline tags in content"),
    preserveChildren: z.boolean()
      .default(false)
      .describe("Whether to preserve child tags when removing parent tags"),
    patterns: z.array(z.string())
      .default([])
      .describe("Tag patterns to match for removal (supports * wildcard)")
  }).default({
    location: 'both',
    normalize: true,
    position: 'end',
    preserveChildren: false,
    patterns: []
  })
}).strict();

type ManageTagsInput = z.infer<typeof schema>;

interface OperationParams {
  files: string[];
  operation: 'add' | 'remove';
  tags: string[];
  options: {
    location: 'frontmatter' | 'content' | 'both';
    normalize: boolean;
    position: 'start' | 'end';
    preserveChildren: boolean;
    patterns: string[];
  };
}

interface OperationReport {
  success: string[];
  errors: { file: string; error: string }[];
  details: {
    [filename: string]: {
      removedTags: Array<{
        tag: string;
        location: 'frontmatter' | 'content';
        line?: number;
        context?: string;
      }>;
      preservedTags: Array<{
        tag: string;
        location: 'frontmatter' | 'content';
        line?: number;
        context?: string;
      }>;
    };
  };
}

async function manageTags(
  vaultPath: string,
  operation: ManageTagsInput
): Promise<OperationReport> {
  const results: OperationReport = {
    success: [],
    errors: [],
    details: {}
  };

  for (const filename of operation.files) {
    const fullPath = path.join(vaultPath, filename);
    
    try {
      // Validate path is within vault
      await validateVaultPath(vaultPath, fullPath);
      
      // Check if file exists
      if (!await fileExists(fullPath)) {
        results.errors.push({
          file: filename,
          error: "File not found"
        });
        continue;
      }

      // Read file content
      const content = await safeReadFile(fullPath);
      if (!content) {
        results.errors.push({
          file: filename,
          error: "Failed to read file"
        });
        continue;
      }

      // Parse the note
      const parsed = parseNote(content);
      let modified = false;
      results.details[filename] = {
        removedTags: [],
        preservedTags: []
      };

      if (operation.operation === 'add') {
        // Handle frontmatter tags for add operation
        if (operation.options.location !== 'content') {
          const updatedFrontmatter = addTagsToFrontmatter(
            parsed.frontmatter,
            operation.tags,
            operation.options.normalize
          );
          
          if (JSON.stringify(parsed.frontmatter) !== JSON.stringify(updatedFrontmatter)) {
            parsed.frontmatter = updatedFrontmatter;
            parsed.hasFrontmatter = true;
            modified = true;
          }
        }

        // Handle inline tags for add operation
        if (operation.options.location !== 'frontmatter') {
          const tagString = operation.tags
            .filter(tag => validateTag(tag))
            .map(tag => `#${operation.options.normalize ? normalizeTag(tag) : tag}`)
            .join(' ');

          if (tagString) {
            if (operation.options.position === 'start') {
              parsed.content = tagString + '\n\n' + parsed.content.trim();
            } else {
              parsed.content = parsed.content.trim() + '\n\n' + tagString;
            }
            modified = true;
          }
        }
      } else {
        // Handle frontmatter tags for remove operation
        if (operation.options.location !== 'content') {
          const { frontmatter: updatedFrontmatter, report } = removeTagsFromFrontmatter(
            parsed.frontmatter,
            operation.tags,
            {
              normalize: operation.options.normalize,
              preserveChildren: operation.options.preserveChildren,
              patterns: operation.options.patterns
            }
          );
          
          results.details[filename].removedTags.push(...report.removed);
          results.details[filename].preservedTags.push(...report.preserved);
          
          if (JSON.stringify(parsed.frontmatter) !== JSON.stringify(updatedFrontmatter)) {
            parsed.frontmatter = updatedFrontmatter;
            modified = true;
          }
        }

        // Handle inline tags for remove operation
        if (operation.options.location !== 'frontmatter') {
          const { content: newContent, report } = removeInlineTags(
            parsed.content,
            operation.tags,
            {
              normalize: operation.options.normalize,
              preserveChildren: operation.options.preserveChildren,
              patterns: operation.options.patterns
            }
          );
          
          results.details[filename].removedTags.push(...report.removed);
          results.details[filename].preservedTags.push(...report.preserved);
          
          if (parsed.content !== newContent) {
            parsed.content = newContent;
            modified = true;
          }
        }
      }

      // Save changes if modified
      if (modified) {
        const updatedContent = stringifyNote(parsed);
        await fs.writeFile(fullPath, updatedContent);
        results.success.push(filename);
      }
    } catch (error) {
      results.errors.push({
        file: filename,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  return results;
}

export function createManageTagsTool(vaults: Map<string, string>) {
  return createTool<ManageTagsInput>({
    name: "manage-tags",
    description: `Add or remove tags from notes, supporting both frontmatter and inline tags.

Examples:
- Add tags: { "vault": "vault1", "files": ["note.md"], "operation": "add", "tags": ["project", "status/active"] }
- Remove tags: { "vault": "vault1", "files": ["note.md"], "operation": "remove", "tags": ["project"] }
- With options: { "vault": "vault1", "files": ["note.md"], "operation": "add", "tags": ["status"], "options": { "location": "frontmatter" } }
- Pattern matching: { "vault": "vault1", "files": ["note.md"], "operation": "remove", "options": { "patterns": ["status/*"] } }
- INCORRECT: { "tags": ["#project"] } (don't include # symbol)`,
    schema,
    handler: async (args, vaultPath, _vaultName) => {
      const results = await manageTags(vaultPath, args);
        
        // Format detailed response message
        let message = '';
        
        // Add success summary
        if (results.success.length > 0) {
          message += `Successfully processed tags in: ${results.success.join(', ')}\n\n`;
        }
        
        // Add detailed changes for each file
        for (const [filename, details] of Object.entries(results.details)) {
          if (details.removedTags.length > 0 || details.preservedTags.length > 0) {
            message += `Changes in ${filename}:\n`;
            
            if (details.removedTags.length > 0) {
              message += '  Removed tags:\n';
              details.removedTags.forEach(change => {
                message += `    - ${change.tag} (${change.location}`;
                if (change.line) {
                  message += `, line ${change.line}`;
                }
                message += ')\n';
              });
            }
            
            if (details.preservedTags.length > 0) {
              message += '  Preserved tags:\n';
              details.preservedTags.forEach(change => {
                message += `    - ${change.tag} (${change.location}`;
                if (change.line) {
                  message += `, line ${change.line}`;
                }
                message += ')\n';
              });
            }
            
            message += '\n';
          }
        }
        
        // Add errors if any
        if (results.errors.length > 0) {
          message += 'Errors:\n';
          results.errors.forEach(error => {
            message += `  ${error.file}: ${error.error}\n`;
          });
        }

        return {
          content: [{
            type: "text",
            text: message.trim()
          }]
        };
    }
  }, vaults);
}
